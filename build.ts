import { resolve } from "path";
import type { BunPlugin } from "bun";
import ortPackage from "onnxruntime-node/package.json";

const ortBin = resolve("node_modules/onnxruntime-node/bin/napi-v6", process.platform, process.arch);
const dylib = process.platform === "darwin" ? "libonnxruntime.1.dylib" : "libonnxruntime.so.1";

// The compiled binary cannot resolve onnxruntime-node at runtime, load sharp's
// native addon, or dlopen an embedded .node whose dylib sits beside it. These
// patches bundle onnxruntime-node and extract its native files on first use.
const bundleOnnxRuntime: BunPlugin = {
  name: "bundle-onnxruntime",
  setup(build) {
    build.onResolve({ filter: /^sharp$/ }, () => ({ path: "sharp", namespace: "sharp-stub" }));
    build.onLoad({ filter: /.*/, namespace: "sharp-stub" }, () => ({
      contents: `export default () => { throw new Error("sharp is not bundled"); };`,
      loader: "js",
    }));

    build.onLoad({ filter: /transformers\.node\.mjs$/ }, async ({ path }) => ({
      contents:
        `import ort from "onnxruntime-node";\n` +
        (await Bun.file(path).text()).replace('requireFromHere("onnxruntime-node")', "ort"),
      loader: "js",
    }));

    build.onLoad({ filter: /onnxruntime-node\/dist\/binding\.js$/ }, async ({ path }) => ({
      contents:
        `import embeddedAddon from "${ortBin}/onnxruntime_binding.node" with { type: "file" };\n` +
        `import embeddedLib from "${ortBin}/${dylib}" with { type: "file" };\n` +
        `import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";\n` +
        `import { homedir } from "os";\n` +
        `function loadBinding() {\n` +
        `  const dir = homedir() + "/.cache/tik/ort-${ortPackage.version}";\n` +
        `  mkdirSync(dir, { recursive: true });\n` +
        `  for (const [source, name] of [[embeddedLib, "${dylib}"], [embeddedAddon, "onnxruntime_binding.node"]]) {\n` +
        `    if (!existsSync(dir + "/" + name)) writeFileSync(dir + "/" + name, readFileSync(source));\n` +
        `  }\n` +
        `  const addon = { exports: {} };\n` +
        `  process.dlopen(addon, dir + "/onnxruntime_binding.node");\n` +
        `  return addon.exports;\n` +
        `}\n` +
        (await Bun.file(path).text()).replace(/require\(`\.\.\/bin[^`]*`\)/, "loadBinding()"),
      loader: "js",
    }));
  },
};

const result = await Bun.build({
  entrypoints: ["main.ts"],
  compile: { outfile: "tik" },
  plugins: [bundleOnnxRuntime],
});

if (!result.success) {
  console.error(result.logs.join("\n"));
  process.exit(1);
}
