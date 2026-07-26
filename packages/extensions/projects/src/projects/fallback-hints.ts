import { getProjectsContext } from "../context.js";

const emittedProjectHints = new Set<string>();
const emittedSliceHints = new Set<string>();

function emitHint(key: string, emitted: Set<string>, message: string): void {
  if (emitted.has(key)) return;
  emitted.add(key);

  try {
    getProjectsContext().logger.warn(message);
  } catch {
    console.error(message);
  }
}

export function emitProjectPitchFallbackHint(projectId: string): void {
  emitHint(
    projectId,
    emittedProjectHints,
    `Project ${projectId} is missing PITCH.md; using README.md body. Run: yoplai projects pitch ${projectId} --from-readme`
  );
}

export function emitSliceSpecsFallbackHint(sliceId: string): void {
  emitHint(
    sliceId,
    emittedSliceHints,
    `Slice ${sliceId} is missing SPECS.md; using README.md body. Run: yoplai slices specs ${sliceId} --from-readme`
  );
}
