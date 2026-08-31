import type { ControlCommand, ParsedControls } from "./types.js";

const PREFIX = "@@RASPI@@";

function decode(line: string): ControlCommand | null {
  const json = line.slice(PREFIX.length).trim();
  try {
    const value: unknown = JSON.parse(json);
    if (typeof value !== "object" || value === null || !("action" in value)) return null;
    const action = (value as { action?: unknown }).action;
    if (action === "end") return { action: "end" };
    if (action === "next") {
      const body = (value as { body?: unknown }).body;
      if (typeof body !== "string" || body.trim() === "") return null;
      return { action: "next", body };
    }
    return null;
  } catch {
    return null;
  }
}

export function parseTrailingControls(response: string): ParsedControls {
  const lines = response.replace(/\r\n/g, "\n").split("\n");
  while (lines.at(-1)?.trim() === "") lines.pop();

  const trailing: string[] = [];
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim() ?? "";
    if (!line.startsWith(PREFIX)) break;
    trailing.unshift(line);
  }

  const commands: ControlCommand[] = [];
  const invalidLines: string[] = [];
  for (const line of trailing) {
    const command = decode(line);
    if (command) commands.push(command);
    else invalidLines.push(line);
  }
  return { commands, invalidLines };
}

export interface ControlDecision {
  sendDot: boolean;
  endCurrent: boolean;
  nextBodies: string[];
  invalidLines: string[];
}

export function decideResponse(response: string): ControlDecision {
  const parsed = parseTrailingControls(response);
  const nextBodies = parsed.commands.flatMap((command) =>
    command.action === "next" && command.body !== undefined ? [command.body] : [],
  );
  const endCurrent =
    nextBodies.length > 0 || parsed.commands.some((command) => command.action === "end");
  return {
    sendDot: !endCurrent,
    endCurrent,
    nextBodies,
    invalidLines: parsed.invalidLines,
  };
}
