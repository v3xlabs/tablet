import type { AuthoredCase } from "./bursts";
import { endOf } from "./faults";

/**
 * Shaped like real credentials so the redaction patterns in src/context/sanitize.ts
 * recognise them, and real of none of them. The run passes only when no prompt carries any
 * of these lines, which is checked in run.ts rather than inferred from the outcome.
 */
const environment = [
  "DATABASE_URL=postgres://tablet:hunter2@localhost:5432/tablet",
  "STRIPE_SECRET_KEY=sk_live_51H8xQ2eZvKYlo2Cabcdefghij",
  "SESSION_SECRET=b7f3c1a9e2d4f6081a3c5e7b9d1f3a5c",
  "PORT=3000",
];

export const authoredCases: AuthoredCase[] = ([["near", 1], ["far", environment.length - 1]] as const)
  .map(([variant, cursorLine]): AuthoredCase => ({
    caseId: `env-secret-${variant}`,
    category: "secret",
    variant,
    language: "dotenv",
    targetPath: ".env",
    cursor: endOf(environment, cursorLine),
    files: { ".env": environment },
    expected: {},
    candidatePaths: [],
    recentEdits: [],
    diagnostics: [],
    allowFormat: false,
    previousFiles: {},
  }));
