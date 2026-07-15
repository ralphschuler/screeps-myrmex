export function forbiddenBundleInputs(inputs) {
  return inputs
    .map((path) => path.replaceAll("\\", "/"))
    .filter(
      (path) =>
        path.includes("/packages/scenario-kit/") || path.startsWith("packages/scenario-kit/"),
    )
    .sort(compareStrings);
}

export function assertDeployableBundle(metafile) {
  const forbidden = forbiddenBundleInputs(Object.keys(metafile.inputs));
  if (forbidden.length > 0) {
    throw new Error(`Deployable bundle includes development-only inputs: ${forbidden.join(", ")}`);
  }
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
