import { expect, test } from 'claude-code/testing';

const paneProps = {
  title: 'Sidecar',
  isFocused: false,
  bodyColumns: 100,
  placement: 'inline',
  scroll: { top: 0, rows: 20 },
  view: { rows: 20 },
} as any;

test('pane draws its empty state', async ($) => {
  const ui = await $.ui.mount({
    plugin: 'cc-sidecar',
    surface: 'terminal',
    component: 'Pane',
    props: paneProps,
    requestId: 'cc-sidecar',
  });
  const tree = await ui.drawn();
  expect(tree).toMatchObject({ type: 'Box' });
  expect((await ui.find({ text: /No agent CLI/ }))?.text).toMatch(
    /No agent CLI/,
  );
});

test('a detected run draws in the pane', async ($) => {
  await $.tool
    .call({
      tool: 'Bash',
      command: 'codex --version',
      description: 'probe',
    } as any)
    .catch(() => null);
  const pane = await $.ui.mount({
    plugin: 'cc-sidecar',
    surface: 'terminal',
    component: 'Pane',
    props: paneProps,
    requestId: 'cc-sidecar',
  });
  const paneTree = await pane.drawn();
  expect(paneTree).toMatchObject({ type: 'Box' });
  expect(await pane.find({ text: /Codex/ })).toBeDefined();
});

test('a running call shows on the prompt hint line', async ($, on) => {
  let release: (() => void) | undefined;
  on('tool.call', { tool: 'Bash' }, () =>
    new Promise<void>((resolve) => {
      release = resolve;
    }).then(
      () => ({ result: { stdout: '', stderr: '', interrupted: false } }) as any,
    ),
  );
  on('ui.render', { component: 'PromptHint' }, ($, e) => {
    const { Text } = $.ui.resolve(e);
    return <Text>engine hint</Text>;
  });
  await ($ as any).command.run({ command: 'cc-sidecar', args: 'both' });
  const call = $.tool
    .call({
      tool: 'Bash',
      command: 'codex --version',
      description: 'probe',
    } as any)
    .catch(() => null);
  const pane = await $.ui.mount({
    plugin: 'cc-sidecar',
    surface: 'terminal',
    component: 'Pane',
    props: paneProps,
    requestId: 'cc-sidecar',
  });
  for (let i = 0; i < 50 && !release; i++) await pane.drawn();
  const hint = await $.ui.mount({
    plugin: 'cc-sidecar',
    surface: 'terminal',
    component: 'PromptHint',
    props: { isDraft: false, isWorking: true, hint: '' },
    viewport: { columns: 120, rows: 40 },
  });
  const tree = await hint.drawn();
  expect(tree).toMatchObject({ type: 'Box' });
  expect(await hint.find({ text: /Codex/ })).toBeDefined();
  expect(await hint.find({ text: /engine hint/ })).toBeDefined();
  release?.();
  await call;
});

test('the slash command answers with usage on a bad mode', async ($) => {
  const { text } = await ($ as any).command.run({
    command: 'cc-sidecar',
    args: 'bogus',
  });
  expect(text).toMatch(/Unknown mode/);
});

test('a background call stays live after the tool result returns', async ($, on) => {
  on(
    'tool.call',
    { tool: 'Bash' },
    () =>
      ({
        result: {
          stdout: 'Command running in background',
          stderr: '',
          interrupted: false,
        },
      }) as any,
  );
  await $.tool
    .call({
      tool: 'Bash',
      command: 'codex --version',
      description: 'probe',
      run_in_background: true,
    } as any)
    .catch(() => null);
  const pane = await $.ui.mount({
    plugin: 'cc-sidecar',
    surface: 'terminal',
    component: 'Pane',
    props: paneProps,
    requestId: 'cc-sidecar',
  });
  await pane.drawn();
  expect(await pane.find({ text: /Codex/ })).toBeDefined();
  expect(await pane.find({ text: /✓/ })).toBeUndefined();
});

test('a finished call hands the model only the final answer', async ($, on) => {
  const jsonl = [
    '{"type":"item.completed","item":{"id":"m","type":"agent_message","text":"hi there"}}',
    '{"type":"turn.completed"}',
    '{"type":"cc-sidecar.exit","code":0}',
    '',
  ].join('\n');
  on(
    'tool.call',
    { tool: 'Bash' },
    () =>
      ({ result: { stdout: jsonl, stderr: '', interrupted: false } }) as any,
  );
  const result: any = await $.tool.call({
    tool: 'Bash',
    command: 'codex exec "say hi"',
    description: 'probe',
  } as any);
  expect(result.result.stdout).toBe('hi there');
});

test('a failed call hands the model the error, not the JSONL', async ($, on) => {
  const jsonl = [
    '{"type":"error","message":"quota exhausted"}',
    '{"type":"cc-sidecar.exit","code":1}',
    '',
  ].join('\n');
  on(
    'tool.call',
    { tool: 'Bash' },
    () =>
      ({
        isError: true,
        result: { stdout: jsonl, stderr: '', interrupted: false },
      }) as any,
  );
  const result: any = await $.tool
    .call({
      tool: 'Bash',
      command: 'codex exec "say hi"',
      description: 'probe',
    } as any)
    .catch((error: any) => error);
  expect(result.result.stdout).toBe('quota exhausted');
});

test('global codex flags before exec still get the rewrite', async ($, on) => {
  let seen = '';
  const jsonl = [
    '{"type":"item.completed","item":{"id":"m","type":"agent_message","text":"ok"}}',
    '{"type":"turn.completed"}',
    '',
  ].join('\n');
  on('tool.call', { tool: 'Bash' }, (_$, e) => {
    seen = String((e as any).command);
    return { result: { stdout: jsonl, stderr: '', interrupted: false } } as any;
  });
  const result: any = await $.tool.call({
    tool: 'Bash',
    command: 'codex --search -m gpt-6-astra exec "say ok"',
    description: 'probe',
  } as any);
  expect(seen).toMatch(/codex --search -m gpt-6-astra exec --json "say ok"/);
  expect(result.result.stdout).toBe('ok');
});

test('a quoted prompt with newlines and semicolons still gets the rewrite', async ($, on) => {
  let seen = '';
  const jsonl = [
    '{"type":"init","session_id":"s","model":"auto"}',
    '{"type":"message","role":"assistant","content":"done","delta":true}',
    '{"type":"result","status":"success","stats":{"models":{}}}',
    '',
  ].join('\n');
  on('tool.call', { tool: 'Bash' }, (_$, e) => {
    seen = String((e as any).command);
    return { result: { stdout: jsonl, stderr: '', interrupted: false } } as any;
  });
  const result: any = await $.tool.call({
    tool: 'Bash',
    command: "gemini -m gemini-3.8-flash -p 'first line;\nsecond line'",
    description: 'probe',
  } as any);
  expect(seen).toMatch(/second line' --output-format stream-json/);
  expect(result.result.stdout).toBe('done');
});

test('a call after a heredoc is detected and rewritten', async ($, on) => {
  let seen = '';
  const jsonl = [
    '{"type":"init","session_id":"s","model":"auto"}',
    '{"type":"message","role":"assistant","content":"done","delta":true}',
    '{"type":"result","status":"success","stats":{"models":{}}}',
    '',
  ].join('\n');
  on('tool.call', { tool: 'Bash' }, (_$, e) => {
    seen = String((e as any).command);
    return { result: { stdout: jsonl, stderr: '', interrupted: false } } as any;
  });
  const result: any = await $.tool.call({
    tool: 'Bash',
    command:
      'cat > /tmp/p.txt <<\'EOF\'\nline one; codex exec\nEOF\ngemini -p "$(cat /tmp/p.txt)"',
    description: 'probe',
  } as any);
  expect(seen).toMatch(/p\.txt\)" --output-format stream-json/);
  expect(result.result.stdout).toBe('done');
});
