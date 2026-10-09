export const REQUIRED_NODE_MAJOR = 24;

export function nodeVersionError(version = process.versions.node) {
  const major = Number(version.split(".")[0]);
  return major >= REQUIRED_NODE_MAJOR
    ? undefined
    : `Oxbit requires Node.js ${REQUIRED_NODE_MAJOR} or later; found Node.js ${version}. Install Node.js ${REQUIRED_NODE_MAJOR} and retry.`;
}

const failure = nodeVersionError();
if (failure) {
  process.stderr.write(failure + "\n");
  process.exit(1);
}
