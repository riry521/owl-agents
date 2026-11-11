import { waitFor } from "./wait.mjs";

/** A ProviderClient whose session answers each turn with the next entry of `script`; `sent` records the turns and `requests` the session requests. */
export function scriptedProvider(script) {
  const sent = [];
  const requests = [];
  const providerClient = {
    createSession: async (request) => {
      requests.push(request);
      let ready = false;
      let handled = 0;
      return {
        provider_session_id: "advisor-scripted-session",
        pid: process.pid,
        send: async (turn) => { sent.push(turn); },
        events: () => ({
          async *[Symbol.asyncIterator]() {
            if (!ready) {
              ready = true;
              yield { type: "session.ready", provider_session_id: "advisor-scripted-session", pid: process.pid };
            }
            for (;;) {
              await waitFor(() => sent.length > handled, { message: "a turn arrives" });
              const turn = sent[handled];
              handled += 1;
              yield { type: "turn.completed", turn_id: turn.turn_id, reply: script.shift() ?? "ok", usage: null };
            }
          },
        }),
        stop: async () => {},
      };
    },
  };
  return { providerClient, sent, requests };
}
