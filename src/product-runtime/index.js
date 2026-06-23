/**
 * Product Runtime — RFC-0011 pattern contract builder and validator.
 *
 * A Product Runtime Manifest defines a long-running KDNA-governed cycle:
 *   Schedule → Select → Generate → Deliver → Observe → Adapt
 *
 * This is a PATTERN CONTRACT, not a runtime engine. Any product runtime
 * (coaching app, learning platform, wellness tracker) implements this contract.
 */

const SCHEDULE_TYPES = ['cron', 'interval', 'event_driven', 'manual'];
const SKIP_POLICIES = ['skip', 'delay', 'generate_immediately'];
const SELECTION_TYPES = ['fixed', 'rotating', 'context_aware', 'user_choice'];
const DOMAIN_ROLES = ['primary', 'advisor', 'constraint', 'risk_guard', 'evaluator', 'style_and_trust'];
const ROTATION_MODES = ['sequential', 'weighted', 'adaptive'];
const GATE_TYPES = ['schema_validation', 'kdna_compliance', 'fidelity_check', 'human_review'];
const LOAD_PROFILES = ['index', 'compact', 'scenario', 'full'];
const DELIVERY_TYPES = ['push_notification', 'email', 'in_app', 'sms', 'api_webhook'];
const OBSERVATION_SOURCES = ['user_reply', 'user_action', 'completion_rate', 'explicit_feedback'];
const ADAPTATION_ACTIONS = ['adjust_tone', 'change_domain', 'increase_detail', 'simplify', 'skip_next', 'escalate', 'repeat_domain'];

/**
 * Create a Product Runtime Manifest with smart defaults.
 */
function createProductRuntime(options = {}) {
  const name = options.name || 'untitled-runtime';
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) {
    throw new Error(`Invalid runtime name "${name}": must match ^[a-z][a-z0-9-]{0,63}$`);
  }

  const manifest = {
    format: 'kdna-product-runtime',
    format_version: '0.1',
    name,
    version: options.version || '0.1.0',
    description: options.description || '',
    schedule: {
      type: options.scheduleType || 'manual',
      skip_policy: options.scheduleSkipPolicy || 'skip',
      max_backlog: options.scheduleMaxBacklog ?? 1,
      timezone: options.timezone || 'UTC',
      ...(options.scheduleType === 'cron' && options.cron ? { cron: options.cron } : {}),
      ...(options.scheduleType === 'interval' ? { interval_seconds: options.intervalSeconds || 3600 } : {}),
      ...(options.scheduleType === 'event_driven' && options.eventTrigger ? { event_trigger: options.eventTrigger } : {}),
    },
    selection: {
      type: options.selectionType || 'fixed',
      domain_pool: options.domainPool || [],
      artifact_type: options.artifactType || 'judgment',
      ...(options.rotation ? { rotation: options.rotation } : {}),
      ...(options.contextSignals ? { context_signals: options.contextSignals } : {}),
      ...(options.userStatePath ? { user_state_path: options.userStatePath } : {}),
    },
    generation: {
      engine: options.engine || 'kdna-core',
      engine_version: options.engineVersion || '1.0',
      artifact_type: options.artifactType || 'judgment',
      kdna_load_profile: options.loadProfile || 'full',
      max_generation_attempts: options.maxGenerationAttempts ?? 1,
      ...(options.template ? { template: options.template } : {}),
      ...(options.qualityGates ? { quality_gates: options.qualityGates } : {}),
    },
    delivery: {
      type: options.deliveryType || 'in_app',
      ...(options.deliveryTemplate ? { template: options.deliveryTemplate } : {}),
      ...(options.deliveryMetadata ? { metadata: options.deliveryMetadata } : {}),
    },
  };

  if (options.observation) {
    manifest.observation = options.observation;
  }

  if (options.adaptation) {
    manifest.adaptation = options.adaptation;
  }

  if (options.trace) {
    manifest.trace = options.trace;
  }

  return manifest;
}

/**
 * Validate a Product Runtime Manifest. Returns { valid, issues }.
 */
function validateProductRuntime(manifest) {
  const issues = [];

  if (!manifest || typeof manifest !== 'object') {
    return { valid: false, issues: ['manifest must be a non-null object'] };
  }

  // Top-level required
  if (manifest.format !== 'kdna-product-runtime') {
    issues.push('format: must be "kdna-product-runtime", got ' + JSON.stringify(manifest.format));
  }
  if (manifest.format_version !== '0.1') {
    issues.push('format_version: must be "0.1", got ' + JSON.stringify(manifest.format_version));
  }
  if (!manifest.name || !/^[a-z][a-z0-9-]{0,63}$/.test(manifest.name)) {
    issues.push(`name: invalid — must match ^[a-z][a-z0-9-]{0,63}$, got ${JSON.stringify(manifest.name)}`);
  }
  if (!manifest.version) {
    issues.push('version: required');
  }
  if (typeof manifest.description === 'string' && manifest.description.length > 280) {
    issues.push('description: must be <= 280 characters');
  }

  // Schedule
  const sched = manifest.schedule;
  if (!sched || typeof sched !== 'object') {
    issues.push('schedule: required object');
  } else {
    if (!SCHEDULE_TYPES.includes(sched.type)) {
      issues.push(`schedule.type: must be one of [${SCHEDULE_TYPES.join(', ')}], got ${JSON.stringify(sched.type)}`);
    }
    if (!SKIP_POLICIES.includes(sched.skip_policy)) {
      issues.push(`schedule.skip_policy: must be one of [${SKIP_POLICIES.join(', ')}]`);
    }
    if (typeof sched.max_backlog !== 'number' || sched.max_backlog < 0 || !Number.isInteger(sched.max_backlog)) {
      issues.push('schedule.max_backlog: must be a non-negative integer');
    }
    if (sched.type === 'cron' && !sched.cron) {
      issues.push('schedule.cron: required when type is "cron"');
    }
    if (sched.type === 'interval') {
      if (typeof sched.interval_seconds !== 'number' || sched.interval_seconds < 60 || !Number.isInteger(sched.interval_seconds)) {
        issues.push('schedule.interval_seconds: required integer >= 60 when type is "interval"');
      }
    }
    if (sched.type === 'event_driven' && !sched.event_trigger) {
      issues.push('schedule.event_trigger: required when type is "event_driven"');
    }
  }

  // Selection
  const sel = manifest.selection;
  if (!sel || typeof sel !== 'object') {
    issues.push('selection: required object');
  } else {
    if (!SELECTION_TYPES.includes(sel.type)) {
      issues.push(`selection.type: must be one of [${SELECTION_TYPES.join(', ')}]`);
    }
    if (!Array.isArray(sel.domain_pool) || sel.domain_pool.length < 1) {
      issues.push('selection.domain_pool: required array with at least 1 domain');
    } else {
      sel.domain_pool.forEach((d, i) => {
        if (!d || typeof d.name !== 'string') {
          issues.push(`selection.domain_pool[${i}]: required field "name"`);
        }
        if (d.role && !DOMAIN_ROLES.includes(d.role)) {
          issues.push(`selection.domain_pool[${i}].role: must be one of [${DOMAIN_ROLES.join(', ')}]`);
        }
      });
    }
    if (!sel.artifact_type) {
      issues.push('selection.artifact_type: required');
    }
    if (sel.rotation && !ROTATION_MODES.includes(sel.rotation)) {
      issues.push(`selection.rotation: must be one of [${ROTATION_MODES.join(', ')}]`);
    }
  }

  // Generation
  const gen = manifest.generation;
  if (!gen || typeof gen !== 'object') {
    issues.push('generation: required object');
  } else {
    if (!gen.engine) issues.push('generation.engine: required');
    if (!gen.artifact_type) issues.push('generation.artifact_type: required');
    if (gen.kdna_load_profile && !LOAD_PROFILES.includes(gen.kdna_load_profile)) {
      issues.push(`generation.kdna_load_profile: must be one of [${LOAD_PROFILES.join(', ')}]`);
    }
    if (typeof gen.max_generation_attempts === 'number' && (!Number.isInteger(gen.max_generation_attempts) || gen.max_generation_attempts < 1)) {
      issues.push('generation.max_generation_attempts: must be a positive integer');
    }
    if (Array.isArray(gen.quality_gates)) {
      gen.quality_gates.forEach((g, i) => {
        if (!GATE_TYPES.includes(g.gate_type)) {
          issues.push(`generation.quality_gates[${i}].gate_type: must be one of [${GATE_TYPES.join(', ')}]`);
        }
        if (typeof g.blocking !== 'boolean') {
          issues.push(`generation.quality_gates[${i}].blocking: must be boolean`);
        }
      });
    }
  }

  // Delivery
  const del = manifest.delivery;
  if (!del || typeof del !== 'object') {
    issues.push('delivery: required object');
  } else {
    if (!DELIVERY_TYPES.includes(del.type)) {
      issues.push(`delivery.type: must be one of [${DELIVERY_TYPES.join(', ')}]`);
    }
  }

  // Observation (optional)
  if (manifest.observation) {
    const obs = manifest.observation;
    if (Array.isArray(obs.sources)) {
      obs.sources.forEach((s, i) => {
        if (!OBSERVATION_SOURCES.includes(s)) {
          issues.push(`observation.sources[${i}]: must be one of [${OBSERVATION_SOURCES.join(', ')}]`);
        }
      });
    }
    if (Array.isArray(obs.signal_mapping)) {
      obs.signal_mapping.forEach((sm, i) => {
        if (!sm.source) issues.push(`observation.signal_mapping[${i}].source: required`);
        if (!sm.extract) issues.push(`observation.signal_mapping[${i}].extract: required`);
        if (!sm.maps_to) issues.push(`observation.signal_mapping[${i}].maps_to: required`);
      });
    }
  }

  // Adaptation (optional)
  if (manifest.adaptation) {
    const adp = manifest.adaptation;
    if (typeof adp.max_adaptation_depth === 'number' && (!Number.isInteger(adp.max_adaptation_depth) || adp.max_adaptation_depth < 1)) {
      issues.push('adaptation.max_adaptation_depth: must be a positive integer');
    }
    if (Array.isArray(adp.adaptation_rules)) {
      adp.adaptation_rules.forEach((r, i) => {
        if (!r.signal_type) issues.push(`adaptation.adaptation_rules[${i}].signal_type: required`);
        if (!r.condition) issues.push(`adaptation.adaptation_rules[${i}].condition: required`);
        if (!ADAPTATION_ACTIONS.includes(r.action)) {
          issues.push(`adaptation.adaptation_rules[${i}].action: must be one of [${ADAPTATION_ACTIONS.join(', ')}]`);
        }
      });
    }
  }

  return { valid: issues.length === 0, issues };
}

/**
 * Minify a Product Runtime Manifest by stripping optional sections when empty.
 */
function compactProductRuntime(manifest) {
  const copy = {
    ...manifest,
    schedule: { ...manifest.schedule },
    selection: { ...manifest.selection, domain_pool: [...(manifest.selection.domain_pool || [])] },
    generation: { ...manifest.generation },
    delivery: { ...manifest.delivery },
  };

  if (!copy.description) delete copy.description;
  if (!copy.schedule.cron) delete copy.schedule.cron;
  if (!copy.schedule.interval_seconds && copy.schedule.type !== 'interval') {
    delete copy.schedule.interval_seconds;
  }
  if (!copy.schedule.event_trigger) delete copy.schedule.event_trigger;
  if (!copy.selection.rotation) delete copy.selection.rotation;
  if (!copy.selection.context_signals || copy.selection.context_signals.length === 0) {
    delete copy.selection.context_signals;
  }
  if (!copy.selection.user_state_path) delete copy.selection.user_state_path;
  if (!copy.generation.template) delete copy.generation.template;
  if (!copy.generation.quality_gates || copy.generation.quality_gates.length === 0) {
    delete copy.generation.quality_gates;
  }
  if (!copy.delivery.template) delete copy.delivery.template;
  if (!copy.delivery.metadata || Object.keys(copy.delivery.metadata).length === 0) {
    delete copy.delivery.metadata;
  }
  if (!copy.observation || (!copy.observation.sources && !copy.observation.signal_mapping)) {
    delete copy.observation;
  }
  if (!copy.adaptation || (copy.adaptation.enabled !== true && !copy.adaptation.adaptation_rules)) {
    delete copy.adaptation;
  }
  if (!copy.trace) delete copy.trace;

  return copy;
}

module.exports = {
  createProductRuntime,
  validateProductRuntime,
  compactProductRuntime,
  SCHEDULE_TYPES,
  SKIP_POLICIES,
  SELECTION_TYPES,
  DOMAIN_ROLES,
  ROTATION_MODES,
  GATE_TYPES,
  LOAD_PROFILES,
  DELIVERY_TYPES,
  OBSERVATION_SOURCES,
  ADAPTATION_ACTIONS,
};
