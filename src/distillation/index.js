// Domain-First Distillation — Core API
// Aligned with SOURCE_DISTILLATION_CONTRACT.md 0.2

// ─── Domain Taxonomy ───────────────────────────────────────────────

const DOMAIN_CATEGORIES = Object.freeze({
  expression_writing: {
    id: 'expression_writing',
    displayName: 'Expression & Writing',
    examples: ['writing_style', 'blog_voice', 'social_media_tone', 'article_structure'],
  },
  aesthetic_creation: {
    id: 'aesthetic_creation',
    displayName: 'Aesthetic & Creation',
    examples: ['visual_design', 'video_rhythm', 'cover_art', 'brand_aesthetics'],
  },
  professional_field: {
    id: 'professional_field',
    displayName: 'Professional Field',
    examples: ['legal_judgment', 'medical_diagnosis', 'education_standards'],
  },
  decision_preference: {
    id: 'decision_preference',
    displayName: 'Decision Preference',
    examples: ['product_decisions', 'investment_criteria', 'prioritization_methods'],
  },
  communication_style: {
    id: 'communication_style',
    displayName: 'Communication Style',
    examples: ['client_communication', 'team_management', 'conflict_handling'],
  },
  workflow_process: {
    id: 'workflow_process',
    displayName: 'Workflow & Process',
    examples: ['project_reviews', 'meeting_standards', 'sales_followups'],
  },
  life_preference: {
    id: 'life_preference',
    displayName: 'Life Preference',
    examples: ['schedule_preferences', 'learning_habits', 'consumption_choices'],
  },
  team_organization: {
    id: 'team_organization',
    displayName: 'Team & Organization',
    examples: ['team_brand', 'hiring_criteria', 'service_standards'],
  },
});

const OWNER_SCOPES = Object.freeze({
  personal: {
    id: 'personal',
    displayName: 'Personal',
    description: 'One person\'s individual standards. Extracts personal preferences, boundaries, taste.',
  },
  team: {
    id: 'team',
    displayName: 'Team',
    description: 'Shared team conventions. Extracts team-wide standards, agreed practices.',
  },
  organization: {
    id: 'organization',
    displayName: 'Organization',
    description: 'Company/organization policies. Extracts organizational values, compliance boundaries.',
  },
  field: {
    id: 'field',
    displayName: 'Industry / Field',
    description: 'Industry/profession-wide. Extracts domain expertise beyond any single practitioner.',
  },
});

const GRANULARITY_LEVELS = Object.freeze({
  core_principles: {
    id: 'core_principles',
    displayName: 'Core Principles',
    description: 'High-level axioms and boundaries. Foundational beliefs, what the person consistently prioritizes and rejects.',
  },
  concrete_patterns: {
    id: 'concrete_patterns',
    displayName: 'Concrete Patterns',
    description: 'Recurring decision patterns. Specific rules and detectable habits.',
  },
  specific_scenarios: {
    id: 'specific_scenarios',
    displayName: 'Specific Scenarios',
    description: 'Scenario-level triggers. Context-specific judgment triggers and responses.',
  },
});

const EVIDENCE_RELEVANCE = Object.freeze({
  relevant: { id: 'relevant', label: 'Relevant' },
  weakly_relevant: { id: 'weakly_relevant', label: 'Weakly Relevant' },
  out_of_scope: { id: 'out_of_scope', label: 'Out of Scope' },
  split_domain: { id: 'split_domain', label: 'Split Domain' },
});

// ─── Distillation Target ───────────────────────────────────────────

function createDistillationTarget({
  domainName,
  domainCategory = 'expression_writing',
  ownerScope = 'personal',
  granularity = 'core_principles',
  taskScope = '',
  includeAreas = [],
  excludeAreas = [],
  loadCondition = '',
}) {
  if (!domainName || typeof domainName !== 'string') {
    throw new Error('domainName is required');
  }
  if (!DOMAIN_CATEGORIES[domainCategory]) {
    throw new Error(`Invalid domainCategory: ${domainCategory}. Must be one of: ${Object.keys(DOMAIN_CATEGORIES).join(', ')}`);
  }
  if (!OWNER_SCOPES[ownerScope]) {
    throw new Error(`Invalid ownerScope: ${ownerScope}`);
  }
  if (!GRANULARITY_LEVELS[granularity]) {
    throw new Error(`Invalid granularity: ${granularity}`);
  }

  return {
    id: `tgt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    domain_name: domainName,
    domain_category: domainCategory,
    owner_scope: ownerScope,
    granularity,
    task_scope: taskScope,
    include_areas: includeAreas,
    exclude_areas: excludeAreas,
    load_condition: loadCondition || `Load when the task involves ${DOMAIN_CATEGORIES[domainCategory].displayName.toLowerCase()} judgment.`,
    declared_at: new Date().toISOString(),
  };
}

function validateDistillationTarget(target) {
  const errors = [];
  if (!target || !target.domain_name) errors.push('domain_name is required');
  if (!DOMAIN_CATEGORIES[target.domain_category]) errors.push(`invalid domain_category: ${target.domain_category}`);
  if (!OWNER_SCOPES[target.owner_scope]) errors.push(`invalid owner_scope: ${target.owner_scope}`);
  if (!GRANULARITY_LEVELS[target.granularity]) errors.push(`invalid granularity: ${target.granularity}`);
  if (!target.task_scope || target.task_scope.trim().length === 0) errors.push('task_scope is required');
  return { valid: errors.length === 0, errors };
}

function targetScopeDescription(target) {
  const cat = DOMAIN_CATEGORIES[target.domain_category];
  const scope = OWNER_SCOPES[target.owner_scope];
  const gran = GRANULARITY_LEVELS[target.granularity];
  return `Domain: ${cat.displayName}. Scope: ${scope.displayName}. Granularity: ${gran.displayName}. Task: ${target.task_scope}. ${target.load_condition}`;
}

// ─── Scope Gate ────────────────────────────────────────────────────

function applyScopeGate(candidate, target) {
  const text = `${candidate.one_sentence || ''} ${candidate.full_statement || ''}`.toLowerCase();
  const domainWords = [target.domain_category, ...(target.include_areas || [])];

  let scopeFit = true;
  let relevanceScore = 50;
  let relevanceEvidence = null;
  let suggestedSplitDomain = null;

  const domainMatch = domainWords.some(w => text.includes(w.toLowerCase()));
  const excludeMatch = (target.exclude_areas || []).some(w => text.includes(w.toLowerCase()));

  if (domainMatch && !excludeMatch) {
    scopeFit = true;
    relevanceScore = 80;
  } else if (!domainMatch && (target.include_areas || []).length > 0) {
    scopeFit = false;
    relevanceScore = 20;
    relevanceEvidence = 'No match with declared include areas';
  } else if (excludeMatch) {
    scopeFit = false;
    relevanceScore = 10;
    relevanceEvidence = 'Matched exclude area';
  }

  if (!scopeFit) {
    for (const [catId, cat] of Object.entries(DOMAIN_CATEGORIES)) {
      if (catId !== target.domain_category) {
        if (text.includes(catId) || text.includes(cat.displayName.toLowerCase())) {
          suggestedSplitDomain = cat.displayName;
          break;
        }
      }
    }
  }

  return {
    ...candidate,
    scope_fit: scopeFit,
    domain_relevance_score: relevanceScore,
    relevance_evidence: relevanceEvidence,
    suggested_split_domain: suggestedSplitDomain,
  };
}

function candidateStatusSummary(candidates) {
  let proposed = 0, accepted = 0, rejected = 0, modified = 0, blocked = 0, outOfScope = 0;
  for (const c of candidates) {
    if (c.sensitive_content_flag) { blocked++; continue; }
    if (!c.scope_fit) { outOfScope++; }
    switch (c.status || c.candidate_status) {
      case 'proposed': proposed++; break;
      case 'accepted': accepted++; break;
      case 'rejected': rejected++; break;
      case 'modified': modified++; break;
    }
  }
  return { proposed, accepted, rejected, modified, blocked, outOfScope };
}

// ─── Sensitive Inference Filter ────────────────────────────────────

const SENSITIVE_KEYWORDS = {
  identity: [
    'gender identity', 'sexual orientation', 'ethnicity', 'race', 'racial',
    '性别认同', '性取向', '种族', '民族',
  ],
  health: [
    'medical condition', 'mental health', 'disability', 'diagnosis', 'medication', 'therapy', 'treatment',
    '疾病', '病史', '诊断', '药物', '治疗', '心理疾病', '精神健康', '残疾', '残障',
  ],
  political: [
    'political affiliation', 'voting', 'activist', 'party member',
    '政治立场', '党派', '党员', '政治倾向',
  ],
  religious: [
    'religious belief', 'faith', 'church', 'prayer', 'worship', 'spiritual practice',
    '宗教信仰', '教会', '祈祷', '礼拜', '信教',
  ],
  financial: [
    'income', 'net worth', 'salary', 'debt', 'bank account', 'savings amount',
    '收入', '工资', '存款', '负债', '资产净值', '银行卡号', '账户余额',
  ],
  intimate: [
    'relationship status', 'marriage', 'divorce', 'family structure',
    '婚姻状况', '离婚', '家庭结构', '感情状况', '亲密关系',
  ],
};

function checkSensitiveContent(text) {
  const lower = text.toLowerCase();
  for (const [domain, keywords] of Object.entries(SENSITIVE_KEYWORDS)) {
    for (const keyword of keywords) {
      if (lower.includes(keyword.toLowerCase())) {
        return { flagged: true, reason: `May involve sensitive domain: ${domain}` };
      }
    }
  }
  return { flagged: false, reason: null };
}

module.exports = {
  DOMAIN_CATEGORIES,
  OWNER_SCOPES,
  GRANULARITY_LEVELS,
  EVIDENCE_RELEVANCE,
  SENSITIVE_KEYWORDS,
  createDistillationTarget,
  validateDistillationTarget,
  targetScopeDescription,
  applyScopeGate,
  candidateStatusSummary,
  checkSensitiveContent,
};
