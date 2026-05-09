import { readFile } from "node:fs/promises";
import path from "node:path";

export async function loadSpec(): Promise<string> {
  const filePath = path.join(process.cwd(), "spec.md");
  return readFile(filePath, "utf8");
}
