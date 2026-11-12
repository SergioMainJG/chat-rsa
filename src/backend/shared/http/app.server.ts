import index from "../../../frontend/index.html";

export interface ServerDependencies {
  readonly port: number;
  readonly development?: boolean;
}

export function createServer({ port, development = false }: ServerDependencies) {
  return Bun.serve({
    port,
    development,
    routes: {
      "/": index,
    },
    fetch: () => Response.json({ error: "Not Found" }, { status: 404 }),
  });
}
