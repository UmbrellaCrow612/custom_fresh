import {
  dirname,
  extname,
  fromFileUrl,
  join,
  toFileUrl,
  walk,
} from "./deps.ts";
import { error } from "./error.ts";

interface Manifest {
  routes: string[];
  islands: string[];
}

export async function collect(directory: string): Promise<Manifest> {
  const routesDir = join(directory, "./routes");
  const islandsDir = join(directory, "./islands");

  const routes = [];
  try {
    const routesUrl = toFileUrl(routesDir);
    // TODO(lucacasonato): remove the extranious Deno.readDir when
    // https://github.com/denoland/deno_std/issues/1310 is fixed.
    for await (const _ of Deno.readDir(routesDir)) {
      // do nothing
    }
    const routesFolder = walk(routesDir, {
      includeDirs: false,
      includeFiles: true,
      exts: ["tsx", "jsx", "ts", "js"],
    });
    for await (const entry of routesFolder) {
      if (entry.isFile) {
        const file = toFileUrl(entry.path).href.substring(
          routesUrl.href.length,
        );
        routes.push(file);
      }
    }
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      // Do nothing.
    } else {
      throw err;
    }
  }
  routes.sort();

  const islands = [];
  try {
    const islandsUrl = toFileUrl(islandsDir);
    for await (const entry of Deno.readDir(islandsDir)) {
      if (entry.isDirectory) {
        error(
          `Found subdirectory '${entry.name}' in islands/. The islands/ folder must not contain any subdirectories.`,
        );
      }
      if (entry.isFile) {
        const ext = extname(entry.name);
        if (![".tsx", ".jsx", ".ts", ".js"].includes(ext)) continue;
        const path = join(islandsDir, entry.name);
        const file = toFileUrl(path).href.substring(islandsUrl.href.length);
        islands.push(file);
      }
    }
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      // Do nothing.
    } else {
      throw err;
    }
  }
  islands.sort();

  return { routes, islands };
}

export async function generate(directory: string, manifest: Manifest) {
  const { routes, islands } = manifest;

  const output = `// DO NOT EDIT. This file is generated by fresh.
// This file SHOULD be checked into source version control.
// This file is automatically updated during development when running \`dev.ts\`.

${
    routes.map((file, i) => `import * as $${i} from "./routes${file}";`).join(
      "\n",
    )
  }
${
    islands.map((file, i) => `import * as $$${i} from "./islands${file}";`)
      .join("\n")
  }

const manifest = {
  routes: {
    ${
    routes.map((file, i) => `${JSON.stringify(`./routes${file}`)}: $${i},`)
      .join("\n    ")
  }
  },
  islands: {
    ${
    islands.map((file, i) => `${JSON.stringify(`./islands${file}`)}: $$${i},`)
      .join("\n    ")
  }
  },
  baseUrl: import.meta.url,
};

export default manifest;
`;

  const proc = Deno.run({
    cmd: [Deno.execPath(), "fmt", "-"],
    stdin: "piped",
    stdout: "piped",
    stderr: "null",
  });
  const raw = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(output));
      controller.close();
    },
  });
  await raw.pipeTo(proc.stdin.writable);
  const out = await proc.output();
  await proc.status();
  proc.close();

  const manifestStr = new TextDecoder().decode(out);
  const manifestPath = join(directory, "./fresh.gen.ts");

  await Deno.writeTextFile(manifestPath, manifestStr);
  console.log(
    `%cThe manifest has been generated for ${routes.length} routes and ${islands.length} islands.`,
    "color: blue; font-weight: bold",
  );
}

export async function dev(base: string, entrypoint: string) {
  entrypoint = new URL(entrypoint, base).href;

  const dir = dirname(fromFileUrl(base));

  let currentManifest: Manifest;
  const prevManifest = Deno.env.get("FRSH_DEV_PREVIOUS_MANIFEST");
  if (prevManifest) {
    currentManifest = JSON.parse(prevManifest);
  } else {
    currentManifest = { islands: [], routes: [] };
  }
  const newManifest = await collect(dir);
  Deno.env.set("FRSH_DEV_PREVIOUS_MANIFEST", JSON.stringify(newManifest));

  const manifestChanged =
    !arraysEqual(newManifest.routes, currentManifest.routes) ||
    !arraysEqual(newManifest.islands, currentManifest.islands);

  if (manifestChanged) await generate(dir, newManifest);

  await import(entrypoint);
}

function arraysEqual<T>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; ++i) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
