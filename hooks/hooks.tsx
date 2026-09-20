import type { Register } from 'claude-code';

const PANE_ID = 'cc-sidecar';
const PLUGIN = 'cc-sidecar';
const MODE_KEY = 'cc-sidecar.mode';
const EXIT_EVENT = 'cc-sidecar.exit';
const TICK_MS = 400;
const LINGER_MS = 10_000;
const PLAIN_MAX = 30;
const ANSWER_WAIT_TICKS = 100;
const HISTORY_MAX = 200;
const DETAIL_ROWS = 40;
const RUNS_MAX = 12;
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const MODES = ['pane', 'hint', 'both', 'off'] as const;
type Mode = (typeof MODES)[number];

const MODE_HELP: Record<Mode, string> = {
  pane: 'open the pane when an agent CLI starts',
  hint: 'show progress on the prompt hint line',
  both: 'pane and hint line',
  off: 'track runs silently; /cc-sidecar still opens the pane',
};

const AGENTS: Record<string, { label: string; glyph: string; color: string }> =
  {
    codex: { label: 'Codex', glyph: '◆', color: 'magenta' },
    gemini: { label: 'Gemini', glyph: '✦', color: 'blue' },
    claude: { label: 'Claude', glyph: '✳', color: 'cyan' },
  };

type Status = 'running' | 'ok' | 'error' | 'interrupted';
type Kind = 'say' | 'think' | 'tool';
type Entry = { kind: Kind; text: string };

type Run = {
  id: string;
  key: string;
  command: string;
  startedAt: number;
  endedAt?: number;
  lingerFrom?: number;
  status: Status;
  logPath?: string;
  threadId?: string;
  answer?: string;
  done?: boolean;
  background?: boolean;
  exitCode?: number;
  failure?: string;
  plain: string[];
  pending?: string;
  model?: string;
  activity: Entry;
  history: Entry[];
  steps: number;
  consumed: number;
};

const runs = new Map<string, Run>();
const order: string[] = [];
const threads: { key: string; threadId: string; at: number }[] = [];

let mode: Mode = 'pane';
let configured = false;
let dismissed = false;
let opened = false;
let announced = false;
let tick: { cancel: () => void } | null = null;
let frame = 0;
let viewing: string | null = null;
let shown = '';

const noop = () => {};

function isMode(value: unknown): value is Mode {
  return (
    typeof value === 'string' && (MODES as readonly string[]).includes(value)
  );
}

function wantsPane(): boolean {
  return (mode === 'pane' || mode === 'both') && !dismissed;
}

function wantsHint(): boolean {
  return mode === 'hint' || mode === 'both';
}

function scan(command: string): string {
  const heads = /<<-?\s*(['"`]?)([A-Za-z_][A-Za-z0-9_]*)\1/g;
  let kept = '';
  let from = 0;
  let head: RegExpExecArray | null;
  while ((head = heads.exec(command))) {
    const lineEnd = command.indexOf('\n', head.index);
    if (lineEnd === -1) break;
    const body = command.slice(lineEnd + 1);
    const end = new RegExp(`^\\t*${head[2]}[ \\t]*$`, 'm').exec(body);
    kept += command.slice(from, lineEnd + 1);
    from = end ? lineEnd + 1 + end.index + end[0].length : command.length;
    heads.lastIndex = from;
  }
  kept += command.slice(from);
  return kept.replace(
    /'[^']*'|"(?:[^"\\]|\\.)*"/g,
    (quoted) => quoted[0]! + quoted[quoted.length - 1]!,
  );
}

function agentFor(command: string): string | null {
  for (const segment of scan(command).split(/\|\||&&|[;|\n]/)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!))
      i++;
    const token = tokens[i];
    if (!token) continue;
    const name = token.slice(token.lastIndexOf('/') + 1);
    if (AGENTS[name]) return name;
  }
  return null;
}

function modelFlag(command: string): string | undefined {
  const match = /(^|\s)(?:-m|--model)(?:\s+|=)("[^"]+"|'[^']+'|[^\s]+)/.exec(
    command,
  );
  if (!match) return undefined;
  return match[2]!.replace(/^["']|["']$/g, '');
}

function trailing(command: string, key: string): boolean {
  const segments = scan(command)
    .split(/\|\||&&|[;|\n]/)
    .filter((part) => part.trim());
  const tokens = (segments[segments.length - 1] ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) i++;
  const token = tokens[i];
  if (!token) return false;
  return token.slice(token.lastIndexOf('/') + 1) === key;
}

const CODEX_EXEC =
  /(^|\s)(codex(?:\s+-\S+(?:\s+(?!exec\b)[^-\s]\S*)?)*\s+exec)\b/;

function structured(key: string, command: string): string | null {
  if (key === 'codex') {
    if (!CODEX_EXEC.test(command)) return null;
    return /(^|\s)--json(\s|$)/.test(command)
      ? command
      : command.replace(CODEX_EXEC, '$1$2 --json');
  }
  if (key === 'claude') {
    if (!/(^|\s)(-p|--print)(\s|$)/.test(command)) return null;
    if (/(^|\s)--output-format(\s|=)/.test(command)) return null;
    if (!trailing(command, key)) return null;
    const verbose = /(^|\s)--verbose(\s|$)/.test(command) ? '' : ' --verbose';
    return `${command} --output-format stream-json${verbose}`;
  }
  if (key === 'gemini') {
    if (!/(^|\s)(-p|--prompt)(\s|$)/.test(command)) return null;
    if (/(^|\s)(-o|--output-format)(\s|=)/.test(command)) return null;
    if (!trailing(command, key)) return null;
    return `${command} --output-format stream-json`;
  }
  return null;
}

async function runsDir($: any): Promise<string> {
  const home = await $.env.get('HOME').catch(() => undefined);
  return `${home ?? '/tmp'}/.cache/${PLUGIN}/runs`;
}

function answerPath(logPath: string): string {
  return logPath.replace(/\.jsonl$/, '.answer');
}

function rewrite(
  key: string,
  command: string,
  dir: string,
  logPath: string,
  background: boolean,
): string | null {
  if (/\|/.test(command)) return null;
  const shaped = structured(key, command);
  if (!shaped) return null;
  const withStdin = /(^|\s)<[^<]/.test(shaped)
    ? shaped
    : `${shaped} < /dev/null`;
  const exit = `printf '{"type":"${EXIT_EVENT}","code":%s}\\n' "$?" >> ${logPath}`;
  if (!background)
    return `mkdir -p ${dir}; set -o pipefail; { ${withStdin} ; } 2>&1 | tee ${logPath}; ${exit}`;
  const answer = answerPath(logPath);
  const wait = `i=0; while [ ! -f ${answer} ] && [ $i -lt ${ANSWER_WAIT_TICKS} ]; do sleep 0.1; i=$((i+1)); done`;
  const fallback = `echo '${PLUGIN}: no answer was extracted; the log is ${logPath}'`;
  return `mkdir -p ${dir}; { ${withStdin} ; } > ${logPath} 2>&1; ${exit}; ${wait}; cat ${answer} 2>/dev/null || ${fallback}`;
}

function remember(run: Run): void {
  runs.set(run.id, run);
  order.push(run.id);
  while (order.length > RUNS_MAX) {
    const dropped = order.shift();
    if (!dropped) continue;
    runs.delete(dropped);
    if (viewing === dropped) viewing = null;
  }
}

function tidy(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function note(run: Run, entry: Entry): void {
  if (!entry.text) return;
  run.activity = entry;
  const last = run.history[run.history.length - 1];
  if (!last || last.text !== entry.text) run.history.push(entry);
  while (run.history.length > HISTORY_MAX) run.history.shift();
}

function toolLine(name: string, input: any): string {
  if (typeof input?.command === 'string') return `$ ${tidy(input.command)}`;
  const detail =
    input?.file_path ?? input?.path ?? input?.pattern ?? input?.dir_path;
  return typeof detail === 'string' ? `${name} ${tidy(detail)}` : name;
}

function describe(item: any): Entry | null {
  if (item.type === 'agent_message' && typeof item.text === 'string') {
    return { kind: 'say', text: tidy(item.text) };
  }
  if (item.type === 'reasoning' && typeof item.text === 'string') {
    return { kind: 'think', text: tidy(item.text) };
  }
  if (item.type === 'command_execution' && typeof item.command === 'string') {
    return { kind: 'tool', text: `$ ${tidy(item.command)}` };
  }
  return null;
}

function absorbCodex(run: Run, event: any): void {
  if (event.thread_id) run.threadId = event.thread_id;
  if (event.type === 'turn.completed') run.done = true;
  if (event.type === 'error' && typeof event.message === 'string')
    run.failure = event.message;
  if (event.type === 'turn.failed') {
    run.failure =
      typeof event.error?.message === 'string'
        ? event.error.message
        : (run.failure ?? 'the turn failed');
    run.done = true;
  }
  const item = event.item;
  if (!item) return;
  if (event.type === 'item.completed') {
    run.steps++;
    if (item.type === 'agent_message' && typeof item.text === 'string') {
      run.answer = item.text;
    }
  }
  const entry = describe(item);
  if (entry) note(run, entry);
}

function absorbClaude(run: Run, event: any): void {
  if (typeof event.session_id === 'string') run.threadId = event.session_id;
  if (typeof event.model === 'string') run.model = event.model;
  if (typeof event.message?.model === 'string') run.model = event.message.model;
  if (event.type === 'assistant') {
    for (const block of event.message?.content ?? []) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        run.steps++;
        note(run, { kind: 'say', text: tidy(block.text) });
      } else if (block?.type === 'tool_use') {
        run.steps++;
        note(run, {
          kind: 'tool',
          text: toolLine(String(block.name ?? 'tool'), block.input),
        });
      }
    }
    return;
  }
  if (event.type === 'result') {
    if (event.is_error === true)
      run.failure =
        typeof event.result === 'string'
          ? event.result
          : 'claude reported an error';
    else if (typeof event.result === 'string') run.answer = event.result;
    run.done = true;
  }
}

function absorbGemini(run: Run, event: any): void {
  if (event.type === 'init') {
    if (typeof event.session_id === 'string') run.threadId = event.session_id;
    if (typeof event.model === 'string') run.model = event.model;
  }
  const used = event.stats?.models;
  if (used) {
    const names = Array.isArray(used) ? used : Object.keys(used);
    if (names.length > 0) run.model = names.join('/');
  }
  if (event.type === 'message') {
    if (event.role !== 'assistant' || typeof event.content !== 'string') return;
    const merged = event.delta
      ? `${run.pending ?? ''}${event.content}`
      : event.content;
    run.pending = merged;
    run.activity = { kind: 'say', text: tidy(merged) };
    return;
  }
  const spoken = (run.pending ?? '').trim();
  run.pending = undefined;
  if (spoken) note(run, { kind: 'say', text: tidy(spoken) });
  if (event.type === 'tool_use') {
    run.steps++;
    note(run, {
      kind: 'tool',
      text: toolLine(String(event.tool_name ?? 'tool'), event.parameters),
    });
    return;
  }
  if (event.type === 'result') {
    if (event.status === 'success') {
      if (spoken) run.answer = spoken;
    } else {
      run.failure =
        typeof event.error?.message === 'string'
          ? event.error.message
          : 'gemini reported an error';
    }
    run.done = true;
  }
}

function keepPlain(run: Run, line: string): void {
  run.plain.push(line);
  while (run.plain.length > PLAIN_MAX) run.plain.shift();
}

function absorb(run: Run, text: string): void {
  const lines = text.split('\n');
  for (let i = run.consumed; i < lines.length - 1; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      keepPlain(run, line);
      continue;
    }
    if (event.type === EXIT_EVENT) {
      run.exitCode = Number(event.code);
      run.done = true;
      continue;
    }
    if (run.key === 'claude') absorbClaude(run, event);
    else if (run.key === 'gemini') absorbGemini(run, event);
    else absorbCodex(run, event);
  }
  run.consumed = Math.max(run.consumed, lines.length - 1);
}

function resumeLine(key: string, threadId: string): string {
  if (key === 'claude') return `claude --resume ${threadId}`;
  if (key === 'gemini') return `gemini --resume latest`;
  return `codex exec resume ${threadId}`;
}

function settle(run: Run, status: Status): void {
  run.status = status;
  run.endedAt = Date.now();
  run.lingerFrom = viewing === run.id ? undefined : run.endedAt;
  if (run.threadId)
    threads.push({ key: run.key, threadId: run.threadId, at: run.endedAt });
}

function digest(run: Run, failed: boolean): string | null {
  if (!run.done)
    return (
      run.failure ??
      (run.plain.length > 0
        ? run.plain.join('\n')
        : 'The run ended before it produced an answer.')
    );
  const first = failed ? run.failure : run.answer;
  const second = failed ? run.answer : run.failure;
  return (
    first ?? second ?? (run.plain.length > 0 ? run.plain.join('\n') : null)
  );
}

function condense(run: Run, result: any): any {
  if (!run.logPath || !result) return result;
  const record = result.result;
  if (!record || typeof record.stdout !== 'string') return result;
  const text = digest(run, result.isError === true);
  if (text === null) return result;
  const trimmed: any = { ...record, stdout: text };
  delete trimmed.persistedOutputPath;
  delete trimmed.persistedOutputSize;
  delete trimmed.rawOutputPath;
  delete trimmed.structuredContent;
  const replaced: any = { ...result, result: trimmed };
  delete replaced.ref;
  delete replaced.text;
  return replaced;
}

function elapsed(run: Run): string {
  const ms = (run.endedAt ?? Date.now()) - run.startedAt;
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function agentOf(run: Run): { label: string; glyph: string; color: string } {
  return AGENTS[run.key] ?? { label: run.key, glyph: '●', color: 'white' };
}

function mark(run: Run): string {
  if (run.status === 'running') return SPINNER[frame % SPINNER.length]!;
  if (run.status === 'ok') return '✓';
  if (run.status === 'interrupted') return '⊘';
  return '✕';
}

function markColor(run: Run): string {
  if (run.status === 'running') return 'yellow';
  if (run.status === 'ok') return 'green';
  return 'red';
}

function kindColor(entry: Entry): string | undefined {
  if (entry.kind === 'tool') return 'cyan';
  return undefined;
}

function kindGlyph(entry: Entry): string {
  if (entry.kind === 'tool') return '›';
  if (entry.kind === 'think') return '·';
  return '»';
}

function clamp(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
}

function live(): Run[] {
  const now = Date.now();
  return order
    .map((id) => runs.get(id))
    .filter((run): run is Run => {
      if (!run) return false;
      if (run.status === 'running' || viewing === run.id) return true;
      return run.lingerFrom !== undefined && now - run.lingerFrom < LINGER_MS;
    });
}

function resolvePress(element: string): string | null {
  if (element === 'back' || element === '← back') return 'back';
  if (element.startsWith('row:')) return element.slice(4);
  const match = live().find((run) => agentOf(run).label === element);
  return match ? match.id : null;
}

function openDetail(id: string): void {
  const run = runs.get(id);
  if (!run) return;
  viewing = id;
  run.lingerFrom = undefined;
}

function closeDetail(): void {
  const run = viewing ? runs.get(viewing) : undefined;
  viewing = null;
  if (run && run.status !== 'running') run.lingerFrom = Date.now();
}

function steps(run: Run): string {
  return `${run.steps} ${run.steps === 1 ? 'step' : 'steps'}`;
}

async function pump($: any): Promise<void> {
  frame++;
  let moved = false;
  for (const run of runs.values()) {
    if (run.status !== 'running' || !run.logPath) continue;
    const text = await $.fs.read(run.logPath).catch(() => null);
    if (typeof text !== 'string') continue;
    const before = run.history.length;
    absorb(run, text);
    if (run.history.length !== before) moved = true;
    if (run.background && run.exitCode !== undefined) {
      settle(run, run.exitCode === 0 ? 'ok' : 'error');
      const text =
        digest(run, run.exitCode !== 0) ?? 'The run ended without an answer.';
      await $.fs.write(answerPath(run.logPath), text).catch(noop);
      moved = true;
    }
  }
  const rows = live();
  const signature = rows.map((run) => `${run.id}:${run.status}`).join(',');
  if (signature !== shown) {
    shown = signature;
    moved = true;
  }
  if (moved || rows.some((run) => run.status === 'running')) {
    $.ui.invalidate('ui.render');
  }
  if (rows.length === 0 && tick) {
    tick.cancel();
    tick = null;
  }
}

function start($: any): void {
  if (tick) return;
  try {
    tick = $.clock.every(TICK_MS, () => void pump($));
  } catch {
    tick = null;
  }
}

async function openPane($: any, focus: boolean): Promise<void> {
  const panes = await $.ui.panes().catch(() => []);
  const isUp = panes.some((pane: any) => pane.id === PANE_ID);
  if (!focus) {
    if (isUp) return;
    if (opened) {
      dismissed = true;
      return;
    }
  }
  dismissed = false;
  await $.ui
    .open({
      id: PANE_ID,
      title: 'Sidecar',
      ...(focus ? { focus: true, rows: 18 } : {}),
    })
    .catch(noop);
  opened = true;
}

async function closePane($: any): Promise<void> {
  await $.ui.close({ id: PANE_ID }).catch(noop);
  opened = false;
}

async function persistMode($: any, next: Mode): Promise<string | null> {
  mode = next;
  const answer = await $.config
    .set({ key: MODE_KEY, value: next })
    .catch(() => ({ deny: 'config unavailable' }));
  if (!answer?.deny) return null;
  await $.store.set('mode', next).catch(noop);
  return String(answer.deny);
}

async function announce($: any): Promise<void> {
  if (announced) return;
  announced = true;
  const answer = await $.command
    .register({
      name: PLUGIN,
      description:
        'Watch delegated agent CLIs (codex, claude, gemini); set where they show',
      argumentHint: `[${MODES.join('|')}]`,
    })
    .catch(() => null);
  if (!answer) announced = false;
}

function usage(): string {
  const lines = MODES.map(
    (name) => `  /cc-sidecar ${name.padEnd(5)} ${MODE_HELP[name]}`,
  );
  return ['Usage: /cc-sidecar [mode]', ...lines].join('\n');
}

function summary(): string {
  const lines = [`mode ${mode} — ${MODE_HELP[mode]}`];
  const resumable = threads.slice(-5).reverse();
  if (resumable.length === 0) {
    lines.push('No resumable sessions yet.');
  } else {
    lines.push('Resume a delegated session:');
    for (const t of resumable) {
      lines.push(
        `  ${AGENTS[t.key]?.label ?? t.key}: ${resumeLine(t.key, t.threadId)}`,
      );
    }
  }
  return lines.join('\n');
}

export const register: Register = (on, options) => {
  if (isMode(options?.mode)) {
    mode = options.mode;
    configured = true;
  }

  on('session.start', {}, async ($, e, next) => {
    await announce($);
    if (!configured) {
      const saved = await $.store.get('mode').catch(() => undefined);
      if (isMode(saved)) mode = saved;
    }
    return next(e);
  });

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const command =
      typeof (e as any).command === 'string' ? (e as any).command : '';
    const key = command ? agentFor(command) : null;
    if (!key) return next(e);

    const id = String((e as any).tool_use_id ?? `run_${Date.now()}`);
    const dir = await runsDir($);
    const logPath = `${dir}/${id}.jsonl`;
    const background = (e as any).run_in_background === true;
    const rewritten = rewrite(key, command, dir, logPath, background);

    const run: Run = {
      id,
      key,
      command,
      startedAt: Date.now(),
      status: 'running',
      background,
      logPath: rewritten ? logPath : undefined,
      model: modelFlag(command),
      activity: rewritten
        ? { kind: 'say', text: 'starting…' }
        : { kind: 'think', text: 'no structured output for this call' },
      history: [],
      plain: [],
      steps: 0,
      consumed: 0,
    };
    remember(run);
    start($);
    void announce($);

    if (wantsPane()) await openPane($, false);
    $.ui.invalidate('ui.render');

    try {
      const result = await next(rewritten ? { ...e, command: rewritten } : e);
      if (run.background && !(result as any)?.isError) return result;
      if (run.logPath) {
        const stdout = (result as any)?.result?.stdout;
        const text = await $.fs.read(run.logPath).catch(() => null);
        absorb(
          run,
          typeof text === 'string'
            ? text
            : typeof stdout === 'string'
              ? stdout
              : '',
        );
      }
      settle(run, (result as any)?.isError ? 'error' : 'ok');
      $.ui.invalidate('ui.render');
      return condense(run, result);
    } catch (error) {
      settle(run, 'error');
      $.ui.invalidate('ui.render');
      throw error;
    }
  });

  on('ui.press', { plugin: PLUGIN, requestId: PANE_ID }, ($, e, next) => {
    const target = resolvePress(String((e as any).element ?? ''));
    if (target === 'back') closeDetail();
    else if (target) openDetail(target);
    else return next(e);
    start($);
    $.ui.invalidate('ui.render');
    return next(e);
  });

  on('command.run', { command: PLUGIN }, async ($, e) => {
    const arg = tidy(String((e as any).args ?? '')).toLowerCase();
    const chosen = isMode(arg) ? arg : null;
    if (arg && !chosen) return { text: `Unknown mode "${arg}".\n${usage()}` };
    const warning = chosen ? await persistMode($, chosen) : null;
    if (!chosen || wantsPane()) await openPane($, true);
    else await closePane($);
    $.ui.invalidate('ui.render');
    const text = warning
      ? `${summary()}\n(${warning}; kept for this machine in the plugin store)`
      : summary();
    return { text };
  });

  on('config.set', { key: MODE_KEY }, async ($, e, next) => {
    const answer = await next(e);
    if (isMode(answer?.value)) {
      mode = answer.value;
      if (!wantsPane() && !wantsHint()) await closePane($);
      $.ui.invalidate('ui.render');
    }
    return answer;
  });

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    void announce($);
    const drawn = await next(e);
    if (!wantsHint()) return drawn;
    const rows = live();
    if (rows.length === 0) return drawn;
    const { Box, Text } = $.ui.resolve(e);
    const columns = e.viewport?.columns ?? 80;
    return (
      <Box flexDirection="column">
        <Text> </Text>
        {rows.map((run, i) => {
          const agent = agentOf(run);
          return (
            <Box key={run.id} flexDirection="row" gap={1}>
              <Text color={agent.color}>
                {agent.glyph} {agent.label.padEnd(6)}
              </Text>
              <Text color={markColor(run)}>{mark(run)}</Text>
              <Text dimColor>{elapsed(run)}</Text>
              {run.steps > 0 ? <Text dimColor>· {steps(run)}</Text> : null}
              {run.model ? (
                <Text dimColor>· {clamp(run.model, 24)}</Text>
              ) : null}
              <Text dimColor>{kindGlyph(run.activity)}</Text>
              <Text
                color={kindColor(run.activity)}
                dimColor={run.activity.kind === 'think'}
                wrap="truncate-end"
              >
                {clamp(run.activity.text, Math.max(20, columns - 60))}
              </Text>
              {i === rows.length - 1 ? drawn : null}
            </Box>
          );
        })}
      </Box>
    );
  });

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, ($, e) => {
    void announce($);
    const { Box, Text, Button } = $.ui.resolve(e);
    const props = (e.props as any) ?? {};
    const width = Math.max(30, (props.bodyColumns ?? 60) - 4);
    const detail = viewing ? runs.get(viewing) : undefined;

    if (detail) {
      const agent = agentOf(detail);
      const entries = detail.history.slice(-DETAIL_ROWS);
      const offset = detail.history.length - entries.length;
      return (
        <Box flexDirection="column" paddingX={1}>
          <Box flexDirection="row" gap={1}>
            <Button key="back" plain hotkey="b" label="← back" onPress={noop} />
            <Text color={agent.color} bold>
              {agent.glyph} {agent.label}
            </Text>
            <Text color={markColor(detail)}>{mark(detail)}</Text>
            <Text dimColor>{elapsed(detail)}</Text>
            {detail.steps > 0 ? <Text dimColor>· {steps(detail)}</Text> : null}
            {detail.model ? <Text dimColor>· {detail.model}</Text> : null}
          </Box>
          <Text dimColor wrap="truncate-end">
            {detail.command}
          </Text>
          {detail.threadId ? (
            <Text dimColor wrap="truncate-end">
              resume: {resumeLine(detail.key, detail.threadId)}
            </Text>
          ) : null}
          <Text> </Text>
          {entries.length === 0 ? (
            <Text dimColor>Nothing recorded yet.</Text>
          ) : (
            entries.map((entry, index) => (
              <Box flexDirection="row" gap={1}>
                <Text dimColor>
                  {String(offset + index + 1).padStart(3, ' ')}
                </Text>
                <Text dimColor>{kindGlyph(entry)}</Text>
                <Text
                  color={kindColor(entry)}
                  dimColor={entry.kind === 'think'}
                  wrap="wrap"
                >
                  {entry.text}
                </Text>
              </Box>
            ))
          )}
        </Box>
      );
    }

    const rows = live();
    return (
      <Box flexDirection="column" paddingX={1}>
        {rows.length === 0 ? (
          <Box flexDirection="column">
            <Text dimColor>No agent CLI is running.</Text>
            <Text dimColor>
              Runs of codex exec, claude -p and gemini -p show up here.
            </Text>
          </Box>
        ) : (
          rows.map((run, index) => {
            const agent = agentOf(run);
            return (
              <Box flexDirection="column">
                <Box flexDirection="row" gap={1}>
                  <Text color={agent.color} bold>
                    {agent.glyph}
                  </Text>
                  <Button
                    key={`row:${run.id}`}
                    plain
                    hotkey={index < 9 ? String(index + 1) : undefined}
                    label={agent.label.padEnd(8)}
                    onPress={noop}
                  />
                  <Text color={markColor(run)}>{mark(run)}</Text>
                  <Text dimColor>{elapsed(run)}</Text>
                  {run.steps > 0 ? <Text dimColor>· {steps(run)}</Text> : null}
                  {run.model ? (
                    <Text dimColor>· {clamp(run.model, 24)}</Text>
                  ) : null}
                </Box>
                <Box flexDirection="row" gap={1} paddingLeft={2}>
                  <Text dimColor>{kindGlyph(run.activity)}</Text>
                  <Text
                    color={kindColor(run.activity)}
                    dimColor={run.activity.kind === 'think'}
                    wrap="wrap"
                  >
                    {clamp(run.activity.text, width * 2 - 4)}
                  </Text>
                </Box>
              </Box>
            );
          })
        )}
        {rows.length > 0 ? (
          <Text dimColor>
            {props.isFocused === true
              ? '1-9 open a run · esc back to the prompt'
              : 'ctrl+x tab to focus · 1-9 open a run · /cc-sidecar for modes'}
          </Text>
        ) : null}
      </Box>
    );
  });
};
