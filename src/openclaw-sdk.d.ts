declare module "*.css";

declare module "node:diagnostics_channel" {
  const diagnostics: {
    subscribe: (name: string, listener: (message: unknown, name: string) => void) => void;
    unsubscribe: (name: string, listener: (message: unknown, name: string) => void) => boolean;
  };
  export default diagnostics;
}

declare module "openclaw/plugin-sdk/feature-plugin" {
  export function defineFeaturePlugin<THandlers>(definition: {
    contract: unknown;
    name: string;
    description: string;
    setup: (api: unknown, events: unknown) => THandlers;
  }): unknown;
}

declare module "openclaw/plugin-sdk/feature-contract" {
  export function defineFeatureContract<TContract>(contract: TContract): TContract;
  export function createFeatureClient(
    contract: { pluginId: string },
    host: {
      pluginId: string;
      request: (method: string, params: unknown) => Promise<unknown>;
      signal: AbortSignal;
      connection: { connected: boolean };
      subscribe: (listener: () => void) => () => void;
      onEvent: (event: string, listener: (payload: unknown) => void) => () => void;
    },
  ): {
    invoke: (operation: string, input: unknown) => Promise<unknown>;
  };
}

declare module "openclaw/plugin-sdk/control-ui" {
  export function defineControlUiPlugin<TPlugin>(plugin: TPlugin): TPlugin;
}
