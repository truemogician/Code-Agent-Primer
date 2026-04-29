import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const home = mkdtempSync(join(tmpdir(), "code-agent-primer-"));
process.env.CODE_AGENT_PRIMER_HOME = home;
