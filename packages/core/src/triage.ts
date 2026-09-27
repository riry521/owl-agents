export interface QAPair {
  index: number;
  question: string;
  answer: string;
}

export interface TriageResult {
  index: number;
  action: "keep" | "drop";
  confidence: number;
}

interface MessageRow {
  id: string;
  body: string;
  provider: string;
  created_at: string;
}

export function splitIntoPairs(messages: readonly MessageRow[]): QAPair[] {
  const pairs: QAPair[] = [];
  let i = 0;
  while (i < messages.length) {
    const isUser = messages[i].provider !== "web";
    if (!isUser) { i++; continue; }

    let question = messages[i].body;
    i++;
    while (i < messages.length && messages[i].provider !== "web") {
      question += "\n" + messages[i].body;
      i++;
    }

    let answer = "";
    while (i < messages.length && messages[i].provider === "web") {
      answer += (answer ? "\n" : "") + messages[i].body;
      i++;
    }

    if (answer) {
      pairs.push({ index: pairs.length, question, answer });
    }
  }
  return pairs;
}

export async function triageConversation(
  pairs: readonly QAPair[],
  apiKey: string | undefined,
): Promise<TriageResult[]> {
  if (!apiKey || pairs.length === 0) {
    return pairs.map((p) => ({ index: p.index, action: "keep" as const, confidence: 0 }));
  }

  const { TypeSafeClient, score } = await import("@typesafe-ai/sdk");
  const client = new TypeSafeClient({ apiKey });

  const results = await Promise.all(
    pairs.map(async (pair): Promise<TriageResult> => {
      try {
        const response = await client.systemOne({
          state: { question: pair.question, answer: pair.answer },
          questions: {
            keep: score("Will this be useful as persistent knowledge?", [
              "No — greeting, thanks, one-time Q&A, or trivially available info",
              "Yes — environment-specific, decision, procedure, or reusable insight",
            ]),
          },
        });
        const fn = response.answers.keep;
        return {
          index: pair.index,
          action: fn.score >= 1.0 ? "keep" : "drop",
          confidence: fn.confidence ?? 0,
        };
      } catch {
        return { index: pair.index, action: "keep", confidence: 0 };
      }
    }),
  );

  return results;
}

export function buildTriagedDocument(
  pairs: readonly QAPair[],
  results: readonly TriageResult[],
  conversationId: string,
): string {
  const kept = results.filter((r) => r.action === "keep");
  if (kept.length === 0) return "";

  const created = new Date().toISOString().slice(0, 10);
  const tags = ["advisor-conversation", "triaged"];

  let doc = `---\ntags: [${tags.join(", ")}]\ncreated: ${created}\nsource: advisor\ntype: conversation\nconversation_id: ${conversationId}\ntriage:\n  total_pairs: ${pairs.length}\n  kept_pairs: ${kept.length}\n---\n\n`;

  for (const k of kept) {
    const pair = pairs[k.index];
    doc += `## Q&A ${k.index + 1}\n\n**Q:** ${pair.question}\n\n**A:** ${pair.answer}\n\n---\n\n`;
  }

  return doc;
}
