import { CapabilityUnsupportedError, type AgentComputerProfile, type Sandbox } from "./sandbox.ts";

const profile: AgentComputerProfile = {
  backend: "disabled",
  writablePersistence: "none",
  processSessions: false,
  egressEnforcement: "none",
};

function unavailable(): never {
  throw new CapabilityUnsupportedError("disabled", "sandbox execution");
}

export function createDisabledSandbox(): Sandbox {
  return {
    profile,
    async provision() {
      return unavailable();
    },
    async run() {
      return unavailable();
    },
    async readFile() {
      return unavailable();
    },
    async writeFile() {
      return unavailable();
    },
    async writeFileBytes() {
      return unavailable();
    },
    async readFileBytes() {
      return unavailable();
    },
    async listDir() {
      return unavailable();
    },
    async removeDir() {
      return unavailable();
    },
    async teardown() {
      return unavailable();
    },
  };
}
