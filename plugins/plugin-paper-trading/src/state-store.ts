import fs from "node:fs";
import path from "node:path";
import type { PaperEngineState } from "./types.js";

export class PaperStateStore {
  constructor(readonly filePath: string) {}

  load(): PaperEngineState | undefined {
    if (!fs.existsSync(this.filePath)) return undefined;
    const raw = fs.readFileSync(this.filePath, "utf8");
    return JSON.parse(raw) as PaperEngineState;
  }

  save(state: PaperEngineState): void {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.tmp-${process.pid}`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(state, null, 2) + "\n", {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      fs.renameSync(temporary, this.filePath);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
}
