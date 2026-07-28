// pluginFactory.mjs — Creates the right plugin instance for a given tenant config.
// Add new rubros here as they are implemented.

import { PropertyPlugin }    from './plugins/propertyPlugin.mjs';
import { AppointmentPlugin } from './plugins/appointmentPlugin.mjs';
import { InquilinoPlugin }   from './plugins/inquilinoPlugin.mjs';

const PLUGIN_REGISTRY = {
  property:    (cfg, fns) => new PropertyPlugin(cfg, fns),
  appointment: (cfg)      => new AppointmentPlugin(cfg),
  health:      (cfg)      => new AppointmentPlugin(cfg),  // alias
  inquilino:   (cfg, fns) => new InquilinoPlugin(cfg, fns),
};

/**
 * Creates a plugin instance based on tenantConfig.plugin.
 *
 * @param {object} tenantConfig - Full tenant config
 * @param {object|null} functions - Dynamically loaded functions.mjs (for property plugin)
 * @returns {BasePlugin}
 */
export function createPlugin(tenantConfig, functions = null) {
  const type    = String(tenantConfig?.plugin || 'property').toLowerCase();
  const factory = PLUGIN_REGISTRY[type];

  if (!factory) {
    console.warn(`pluginFactory: unknown plugin type "${type}", falling back to "property"`);
    return new PropertyPlugin(tenantConfig, functions);
  }

  return factory(tenantConfig, functions);
}
