/**
 * Shared SSE fixtures for Pi tests: minimal OpenAI Responses streams the
 * pi-ai adapter accepts (verified against its parser, not hand-waved).
 * Not a test file itself (no `.test` suffix) so vitest never collects it.
 */

/** One text answer round. */
export function sseAnswer(text: string): Response {
  const item = {
    id: "msg_1",
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  const events = [
    { type: "response.created", response: { id: "resp_1" } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    { type: "response.output_text.delta", output_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "resp_1",
        status: "completed",
        output: [item],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
    },
  ];
  return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** One function-call round (tool round), then the model waits for results. */
export function sseToolCall(calls: { callId: string; id: string; name: string; args: Record<string, unknown> }[]): Response {
  const items = calls.map((c) => ({
    id: c.id,
    type: "function_call",
    call_id: c.callId,
    name: c.name,
    arguments: JSON.stringify(c.args),
  }));
  const events: unknown[] = [{ type: "response.created", response: { id: "resp_1" } }];
  calls.forEach((c, i) => {
    events.push({ type: "response.output_item.added", output_index: i, item: { ...items[i], arguments: "" } });
    events.push({ type: "response.function_call_arguments.delta", output_index: i, delta: JSON.stringify(c.args) });
    events.push({ type: "response.function_call_arguments.done", output_index: i, arguments: JSON.stringify(c.args) });
    events.push({ type: "response.output_item.done", output_index: i, item: items[i] });
  });
  events.push({
    type: "response.completed",
    response: {
      id: "resp_1",
      status: "completed",
      output: items,
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    },
  });
  return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}
