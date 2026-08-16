export interface DockerSandboxSpec {
  image: string;
  name: string;
  networkName: string;
  volumeName: string;
  tokenMountPath: string;
  capDrop: string[];
  env: string[];
}

export interface DockerContainerInfo {
  id: string;
  name: string;
  state: string;
}

export interface DockerClient {
  pullImage(image: string): Promise<void>;
  createNetwork(name: string, internal: boolean): Promise<void>;
  createVolume(name: string): Promise<void>;
  createContainer(spec: DockerSandboxSpec): Promise<string>;
  startContainer(id: string): Promise<void>;
  stopAndRemoveContainer(id: string): Promise<void>;
  removeNetwork(name: string): Promise<void>;
  removeVolume(name: string): Promise<void>;
  inspectContainer(name: string): Promise<DockerContainerInfo | null>;
  listContainersByLabel(label: string): Promise<DockerContainerInfo[]>;
  writeFileIntoContainer(containerId: string, path: string, content: string): Promise<void>;
}

export function createDockerClient(opts: {
  socketPath?: string;
  exec?: (command: string) => Promise<{ code: number; stdout: string; stderr: string }>;
} = {}): DockerClient {
  const exec =
    opts.exec ??
    (async (command: string) => {
      const { spawnSync } = await import("node:child_process");
      const res = spawnSync("sh", ["-c", command], { encoding: "utf8" });
      return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
    });
  const run = async (command: string): Promise<void> => {
    const res = await exec(command);
    if (res.code !== 0) throw new Error(`docker command failed: ${command}\n${res.stderr}`);
  };
  return {
    async pullImage(image) {
      const res = await exec(`docker image inspect ${shellQuote(image)} >/dev/null 2>&1 && echo LOCAL`);
      if (res.stdout.trim() === "LOCAL") return;
      await run(`docker image pull ${shellQuote(image)}`);
    },
    async createNetwork(name, internal) {
      await run(`docker network create ${internal ? "--internal" : ""} ${shellQuote(name)}`);
    },
    async createVolume(name) {
      await run(`docker volume create ${shellQuote(name)}`);
    },
    async createContainer(spec) {
      const capArgs = spec.capDrop.map((c) => `--cap-drop ${c}`).join(" ");
      const envArgs = spec.env.map((e) => `-e ${shellQuote(e)}`).join(" ");
      const res = await exec(
        `docker create ${capArgs} ${envArgs} --name ${shellQuote(spec.name)} --network ${shellQuote(spec.networkName)} ` +
          `--volume ${shellQuote(spec.volumeName)}:${shellQuote(spec.tokenMountPath)} ${shellQuote(spec.image)}`,
      );
      if (res.code !== 0) throw new Error(`docker create failed: ${res.stderr}`);
      return res.stdout.trim();
    },
    async startContainer(id) {
      await run(`docker start ${shellQuote(id)}`);
    },
    async stopAndRemoveContainer(id) {
      await run(`docker rm -f ${shellQuote(id)}`).catch(() => undefined);
    },
    async removeNetwork(name) {
      await run(`docker network rm ${shellQuote(name)}`).catch(() => undefined);
    },
    async removeVolume(name) {
      await run(`docker volume rm ${shellQuote(name)}`).catch(() => undefined);
    },
    async inspectContainer(name) {
      const res = await exec(`docker inspect --format '{{.Id}} {{.Name}} {{.State.Status}}' ${shellQuote(name)}`);
      if (res.code !== 0) return null;
      const parts = res.stdout.trim().split(/\s+/);
      if (parts.length < 3) return null;
      return { id: parts[0]!, name: parts[1]!, state: parts[2]! };
    },
    async listContainersByLabel(label) {
      const res = await exec(`docker ps -aq --filter label=${shellQuote(label)}`);
      if (res.code !== 0) return [];
      const ids = res.stdout.trim().split(/\s+/).filter(Boolean);
      const out: DockerContainerInfo[] = [];
      for (const id of ids) {
        const info = await this.inspectContainer(id);
        if (info) out.push(info);
      }
      return out;
    },
    async writeFileIntoContainer(containerId, path, content) {
      const tmp = `/tmp/rt-token-${Date.now()}`;
      await run(`printf %s ${shellQuote(content)} > ${shellQuote(tmp)}`);
      await run(`docker cp ${shellQuote(tmp)} ${shellQuote(containerId)}:${shellQuote(path)}`).finally(() => {
        void exec(`rm -f ${shellQuote(tmp)}`);
      });
    },
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
