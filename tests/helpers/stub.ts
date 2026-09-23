/**
 * A Jev endpoint stand-in that answers every noul question through a callback,
 * so a test can decide per question id what the model "thinks".
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";

import { _resetConfigCache } from "../../src/config.ts";

export async function withNoulStub(
  answer: (id: string, body: Record<string, unknown>) => number,
  run: (baseUrl: string, bodies: Array<Record<string, unknown>>) => Promise<void>,
): Promise<void> {
  const bodies: Array<Record<string, unknown>> = [];
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      bodies.push(body);
      const questions = (body.questions ?? {}) as Record<string, unknown>;
      const answers: Record<string, unknown> = {};
      for (const id of Object.keys(questions)) answers[id] = { type: "noul", noul: answer(id, body) };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ model: "jev-stub", answers, usage: { input_tokens: 100, output_tokens: 0 } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}/v1`, bodies);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

export function writeConfig(home: string, value: Record<string, unknown>): void {
  const file = path.join(home, ".pi", "jev-config.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value), "utf-8");
  _resetConfigCache();
}

export function stubProvider(url: string) {
  return [{ id: "stub", kind: "jev", baseUrl: url, model: "stub", apiKey: "x" }];
}
