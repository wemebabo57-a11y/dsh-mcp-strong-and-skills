/** Accessible native controls inherit the Harness theme and work without a UI dependency. */
export const SETTINGS_CSS = `
.strong-settings{--ss-line:var(--dsw-alias-border-l2,#d5d8de);--ss-muted:var(--dsw-alias-label-secondary,#666);font:inherit;color:inherit;max-width:760px;padding:8px 0 28px}
.strong-settings *{box-sizing:border-box}.strong-settings h2{font:inherit;font-size:22px;font-weight:650;letter-spacing:-.03em;margin:0 0 8px}
.strong-settings h3{font:inherit;font-size:14px;font-weight:650;margin:0 0 12px}.strong-settings p{margin:4px 0;line-height:1.6}
.strong-settings__intro,.strong-settings__hint{color:var(--ss-muted);font-size:13px}.strong-settings__group{margin:24px 0 0;padding:0 0 24px;border-bottom:1px solid var(--ss-line)}
.strong-settings__row{display:grid;grid-template-columns:minmax(0,1fr) minmax(145px,220px);gap:18px;align-items:center;padding:12px 0}
.strong-settings__modes .strong-settings__row{grid-template-columns:minmax(0,1fr) auto}
.strong-settings__row label{display:block;font-size:14px;font-weight:550}.strong-settings__row select,.strong-settings__row input[type=number],.strong-settings textarea{font:inherit;color:inherit;background:transparent;border:1px solid var(--ss-line);border-radius:8px;min-height:38px;padding:8px 10px;width:100%}
.strong-settings__row option{color:var(--dsw-alias-label-primary,CanvasText);background:var(--dsw-alias-bg-layer-3,Canvas)}.strong-settings input[type=checkbox]{width:36px;height:22px;justify-self:end;accent-color:var(--dsw-alias-state-business-primary,#63764b);cursor:pointer}
.strong-settings input:focus-visible,.strong-settings select:focus-visible,.strong-settings textarea:focus-visible,.strong-settings button:focus-visible,.strong-settings summary:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#63764b);outline-offset:3px}
.strong-settings__row :disabled,.strong-settings textarea:disabled{opacity:.5;cursor:not-allowed}.strong-settings textarea{resize:vertical;min-height:78px;margin-top:10px}.strong-settings__footer{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-top:22px}
.strong-settings button{font:inherit;color:inherit;border:1px solid var(--ss-line);border-radius:8px;background:transparent;padding:8px 12px;cursor:pointer}.strong-settings button:disabled{opacity:.5;cursor:not-allowed}.strong-settings__status{min-height:24px;color:var(--ss-muted);font-size:13px}.strong-settings__error{color:var(--dsw-alias-state-error-primary,#b42318)}
.strong-settings details{margin-top:24px}.strong-settings summary{font-size:14px;font-weight:550;cursor:pointer}.strong-settings__notice{padding:12px 14px;background:color-mix(in srgb,currentColor 5%,transparent);border-radius:8px;margin-top:14px!important}
@media(prefers-color-scheme:dark){.strong-settings{--ss-line:var(--dsw-alias-border-l2,#444);--ss-muted:var(--dsw-alias-label-secondary,#aaa)}}
@media(max-width:560px){.strong-settings__row{grid-template-columns:minmax(0,1fr) minmax(120px,42%);gap:12px}.strong-settings h2{font-size:20px}}
`;

export const EN = Object.freeze({
  title: 'Strong Skills', intro: 'Every model gets stronger planning, verification, and clarification. DeepSeek strategies add specialized guidance.',
  persistence: 'Changes save to this Harness profile and apply to the next request.',
  loading: 'Loading saved preferences…', unavailable: 'Strong Skills settings are unavailable in this profile.',
  availabilityTitle: 'Check the Harness connection',
  availabilityHint: 'The Strong Skills browser interface is loaded. Its settings become editable when the Host exposes the strong-skills settings namespace.',
  availabilityProfile: 'Confirm that dsh-strong-skills is installed and enabled in the Harness profile serving this page. Another profile or Host can have different plugins.',
  availabilityVersion: 'Use a compatible Harness version (0.2.1-rc.3 or newer, below 0.3.0), then restart Harness and reload this page after installing or updating the plugin.',
  availabilityLogs: 'If the settings still do not load, check the Host plugin logs for a failed startup or rejected settings schema. This page will update automatically when the Host serves the settings.',
  readonly: 'This profile is read only. Saved preferences are shown below.',
  enhanced: 'Enhanced thinking', enhancedHint: 'Plan before acting, inspect uncertainty, and verify important results.',
  off: 'Enhanced thinking is off. Enable it to use the thinking and clarification preferences below.',
  thinking: 'Thinking level', thinkingHint: 'Controls the depth of Strong Skills planning and verification.',
  balanced: 'Balanced', deep: 'Deep', clarification: 'Clarification', clarificationHint: 'Choose how often Strong Skills asks about meaningful uncertainty.',
  auto: 'Automatic', more: 'Ask more', few: 'Ask less', model: 'Model strategy', modelHint: 'Universal enhancements for every model, with specialized DeepSeek guidance. The actual model stays selected.',
  pro: 'DeepSeek V4 Pro', flash: 'DeepSeek V4.1 Flash · 1017', generic: 'Universal',
  modelNote: 'Automatic uses specialized guidance for supported DeepSeek models and universal enhancements for all others. Choose the actual model and provider reasoning settings in Settings → Models. The Flash strategy follows the rolling deepseek-flash API model.',
  tools: 'Tool set', toolsHint: 'Expanded adds navigation and inspection tools; compact keeps the core tools.', compact: 'Compact', expanded: 'Expanded',
  modes: 'Working modes', modesHint: 'Optional guidance; all modes start off and can be combined.',
  claudeMode: 'Claude mode', claudeModeHint: 'For every model: frontend inspiration from warm neutrals, clear hierarchy, whitespace, and restrained accents; task guidance follows goals, evidence, and verification. Your project’s brand comes first.',
  weNeedToThinking: 'we need to thinking', weNeedToThinkingHint: 'For every model: asks the model to open its thinking with a “We need to …” goal statement, then move through facts, evidence, action, verification, and risks. Works with any provider or model name.',
  unlimitedTokens: 'Unlimited token mode', unlimitedTokensHint: 'For every model: removes this plugin’s output caps and context limits, expands skill reads to eight, and asks for exhaustive planning, implementation, and verification. Token use increases substantially.',
  modesNote: 'These modes provide style and task guidance, without switching models or reproducing Claude’s private reasoning. Unlimited token mode trades tokens for completeness.',
  unlimitedOn: 'Unlimited token mode is on: tool results are not truncated, workspace reads use maximum bounds, and skill reads can return up to eight bodies. Token use will increase substantially.',
  modesThinkingOff: 'Enhanced thinking is off. Claude frontend guidance remains active; Claude planning guidance is paused. The we need to mode and unlimited token mode continue to work. Your mode preferences stay saved.',
  budget: 'Resource budget', profile: 'Profile', profileHint: 'Set the default amount of workspace context and tool output.', lean: 'Lean', thorough: 'Thorough',
  design: 'Design preferences', brand: 'Allow brand colors', brandHint: 'Use brand colors when a project needs them.', intent: 'Brand intent', intentHint: 'Optional design direction, up to 200 characters. Saved when you leave the field.',
  advanced: 'Advanced limits', advancedHint: 'Custom limits override profile defaults. Number edits save when you leave the field.',
  maxOutputChars: 'Output characters', maxFiles: 'Files per scan', maxFileBytes: 'Bytes per file', maxSkillLoads: 'Skill loads per call',
  reset: 'Use inherited settings',
  saved: 'Saved', saving: 'Saving…', refused: 'The change was refused. The saved profile values have been reloaded.', failed: 'Could not save. Check the connection and try again.',
});

export const ZH = Object.freeze({
  title: 'Strong Skills 编程增强', intro: '所有模型均可增强规划、验证与需求澄清；DeepSeek 策略额外提供专用指导。',
  persistence: '更改会保存到当前 Harness 配置，并在下一次请求时生效。',
  loading: '正在加载已保存的设置…', unavailable: '当前配置中没有可用的 Strong Skills 设置。', readonly: '当前配置为只读，以下为已保存的设置。',
  availabilityTitle: '检查 Harness 连接',
  availabilityHint: 'Strong Skills 浏览器界面已加载。Host 提供 strong-skills 设置命名空间后，即可编辑设置。',
  availabilityProfile: '请确认 dsh-strong-skills 已安装，并在当前页面所连接的 Harness 配置中启用。不同配置或 Host 的插件可能不同。',
  availabilityVersion: '请使用兼容的 Harness 版本（0.2.1-rc.3 及以上、低于 0.3.0）。安装或更新插件后，重启 Harness 并重新加载此页面。',
  availabilityLogs: '如果设置仍未加载，请检查 Host 插件日志中的启动失败或设置结构被拒绝信息。Host 提供设置后，此页面会自动更新。',
  enhanced: '增强思考', enhancedHint: '执行前规划，识别不确定性，并验证重要结果。', off: '增强思考已关闭。开启后可使用下方的思考与澄清偏好。',
  thinking: '思考等级', thinkingHint: '调整 Strong Skills 的规划与验证深度。', balanced: '均衡', deep: '深度',
  clarification: '澄清频率', clarificationHint: '遇到会影响结果的不确定性时，选择主动询问的频率。', auto: '自动', more: '多问一些', few: '少问一些',
  model: '模型策略', modelHint: '所有模型均有通用增强，DeepSeek 可选专用指导；不切换实际模型。', pro: 'DeepSeek V4 Pro', flash: 'DeepSeek V4.1 Flash · 1017', generic: '通用增强',
  modelNote: '「自动」为支持的 DeepSeek 模型应用专用指导，其他模型保留全部通用增强。实际模型及推理参数请在「设置 → 模型」中选择。Flash 策略对应滚动更新的 deepseek-flash API 模型。',
  tools: '工具集', toolsHint: '扩展模式增加导航与检查工具；精简模式保留核心工具。', compact: '精简', expanded: '扩展',
  modes: '工作模式', modesHint: '按需开启，所有模式默认关闭，可同时使用。',
  claudeMode: 'Claude 模式', claudeModeHint: '适用于所有模型：前端参考暖中性色、清晰层级、留白与克制的强调色；解题从目标、证据到验证展开。优先尊重项目品牌。',
  weNeedToThinking: 'we need to 思维', weNeedToThinkingHint: '对所有模型生效：思考开头先写“We need to …”明确目标，再按事实、证据、行动、验证与风险展开；不依赖模型名称或服务商。',
  unlimitedTokens: '无限 token 模式', unlimitedTokensHint: '对所有模型生效：取消本插件输出上限与上下文限制，技能读取放宽到 8 个，并要求穷尽式规划、实现与验证。token 消耗会显著增加。',
  modesNote: '模式提供风格与解题方法引导，不切换模型，也不复现 Claude 的内部推理；无限 token 模式用更多消耗换取完整性与验证深度。',
  unlimitedOn: '无限 token 模式已开启：工具结果不再截断，工作区按最大范围读取，单次最多读取 8 个技能正文。token 消耗会显著增加。',
  modesThinkingOff: '增强思考已关闭：Claude 前端指导仍生效，其规划引导暂停；we need to 思维与无限 token 模式继续工作，模式偏好继续保存。',
  budget: '资源预算', profile: '资源档位', profileHint: '设置工作区上下文与工具输出的默认用量。', lean: '轻量', thorough: '详尽',
  design: '设计偏好', brand: '允许品牌色', brandHint: '项目需要时使用品牌色。', intent: '品牌意图', intentHint: '可选的设计方向，最多 200 字；离开输入框时保存。',
  advanced: '高级限制', advancedHint: '自定义限制优先于资源档位的默认值；离开数字输入框时保存。',
  maxOutputChars: '输出字符数', maxFiles: '每次扫描文件数', maxFileBytes: '单文件字节数', maxSkillLoads: '单次技能加载数',
  reset: '恢复继承设置', saved: '已保存', saving: '正在保存…',
  refused: '更改未被接受，已重新加载保存的配置。', failed: '保存失败，请检查连接后重试。',
});

/** The slot renderer supplies useStrongSettings from the controller's snapshot store. */
export function createSettingsSection(h) {
  return function StrongSettings(props) {
    const t = props.t ?? (key => EN[key] ?? key);
    if (props.view === 'summary') return t('intro');
    const state = props.useStrongSettings(snapshot => snapshot);
    const id = props.surfaceId ?? 'strong-skills-settings';
    const headingId = `${id}-heading`;
    if (state.status !== 'ready' || state.value === undefined) {
      return h('section', { className: 'strong-settings', 'aria-labelledby': headingId },
        h('h2', { id: headingId }, t('title')),
        h('p', { className: 'strong-settings__intro' }, t('intro')),
        h('p', { role: 'status', 'aria-live': 'polite' }, t(state.status === 'loading' ? 'loading' : 'unavailable')),
        h('div', { className: 'strong-settings__group' },
          h('h3', null, t('availabilityTitle')),
          h('p', { className: 'strong-settings__hint' }, t('availabilityHint')),
          h('p', { className: 'strong-settings__hint' }, t('availabilityProfile')),
          h('p', { className: 'strong-settings__hint' }, t('availabilityVersion')),
          h('p', { className: 'strong-settings__hint' }, t('availabilityLogs'))));
    }
    const value = state.value;
    const disabled = !state.writable || state.saving;
    const thinkingDisabled = disabled || value.enhancedThinking !== true;
    const fieldId = field => `${id}-${field}`;
    const hintId = field => `${fieldId(field)}-hint`;
    function row(field, label, hint, control) {
      return h('div', { className: 'strong-settings__row', key: field },
        h('div', null, h('label', { htmlFor: fieldId(field) }, t(label)),
          hint ? h('p', { id: hintId(field), className: 'strong-settings__hint' }, t(hint)) : null), control);
    }
    function select(field, label, hint, options, isDisabled = disabled) {
      return row(field, label, hint, h('select', {
        id: fieldId(field), value: value[field], disabled: isDisabled,
        'aria-describedby': hintId(field), onChange: event => { void props.set(field, event.currentTarget.value); },
      }, ...options.map(([choice, key]) => h('option', { key: choice, value: choice }, t(key)))));
    }
    function toggle(field, label, hint) {
      return row(field, label, hint, h('input', {
        id: fieldId(field), type: 'checkbox', role: 'switch', checked: value[field] === true,
        disabled, 'aria-describedby': hintId(field),
        onChange: event => { void props.set(field, event.currentTarget.checked); },
      }));
    }
    function limit(field, min, max) {
      return row(field, field, null, h('input', {
        // The key adopts externally saved values while allowing an incomplete local edit until blur.
        key: `${field}:${value[field]}`, id: fieldId(field), type: 'number', min, max, step: 1,
        defaultValue: value[field], disabled,
        onBlur: event => {
          const input = event.currentTarget;
          if (input.value !== String(value[field])) {
            if (input.value === '' || !input.checkValidity()) { input.reportValidity(); input.value = String(value[field]); return; }
            void props.set(field, Number(input.value)).then(accepted => { if (!accepted) input.value = String(value[field]); });
          }
        },
      }));
    }
    return h('section', { className: 'strong-settings', 'aria-labelledby': headingId, 'aria-busy': state.saving },
      h('h2', { id: headingId }, t('title')),
      h('p', { className: 'strong-settings__intro' }, t('intro')),
      h('p', { className: 'strong-settings__hint' }, t('persistence')),
      !state.writable ? h('p', { className: 'strong-settings__notice', role: 'status' }, t('readonly')) : null,
      h('div', { className: 'strong-settings__group' },
        toggle('enhancedThinking', 'enhanced', 'enhancedHint'),
        !value.enhancedThinking ? h('p', { className: 'strong-settings__notice' }, t('off')) : null,
        select('thinkingLevel', 'thinking', 'thinkingHint', [['balanced', 'balanced'], ['deep', 'deep']], thinkingDisabled),
        select('clarification', 'clarification', 'clarificationHint', [['auto', 'auto'], ['more', 'more'], ['few', 'few']], thinkingDisabled),
        select('modelPreset', 'model', 'modelHint', [['auto', 'auto'], ['deepseek-v4-pro', 'pro'], ['deepseek-v4.1-flash-1017', 'flash'], ['generic', 'generic']]),
        h('p', { className: 'strong-settings__hint' }, t('modelNote')),
        select('toolSet', 'tools', 'toolsHint', [['compact', 'compact'], ['expanded', 'expanded']])),
      h('div', { className: 'strong-settings__group strong-settings__modes' },
        h('h3', null, t('modes')),
        h('p', { className: 'strong-settings__hint' }, t('modesHint')),
        toggle('claudeMode', 'claudeMode', 'claudeModeHint'),
        toggle('weNeedToThinking', 'weNeedToThinking', 'weNeedToThinkingHint'),
        toggle('unlimitedTokens', 'unlimitedTokens', 'unlimitedTokensHint'),
        h('p', { className: 'strong-settings__hint' }, t('modesNote')),
        value.unlimitedTokens
          ? h('p', { className: 'strong-settings__notice', role: 'status' }, t('unlimitedOn')) : null,
        !value.enhancedThinking && value.claudeMode
          ? h('p', { className: 'strong-settings__notice', role: 'status' }, t('modesThinkingOff')) : null),
      h('div', { className: 'strong-settings__group' },
        h('h3', null, t('budget')),
        select('profile', 'profile', 'profileHint', [['lean', 'lean'], ['balanced', 'balanced'], ['thorough', 'thorough']]),
        h('details', null, h('summary', null, t('advanced')),
          h('p', { className: 'strong-settings__hint' }, t('advancedHint')),
          limit('maxOutputChars', 2000, 20000), limit('maxFiles', 20, 5000),
          limit('maxFileBytes', 1024, 262144), limit('maxSkillLoads', 1, 2))),
      h('div', { className: 'strong-settings__group' }, h('h3', null, t('design')),
        toggle('allowBrandColors', 'brand', 'brandHint'),
        h('label', { htmlFor: fieldId('brandIntent') }, t('intent')),
        h('p', { className: 'strong-settings__hint', id: hintId('brandIntent') }, t('intentHint')),
        h('textarea', {
          key: `brandIntent:${value.brandIntent ?? ''}`, id: fieldId('brandIntent'),
          maxLength: 200, rows: 2, defaultValue: value.brandIntent ?? '', disabled,
          'aria-describedby': hintId('brandIntent'),
          onBlur: event => {
            const input = event.currentTarget;
            if (input.value !== (value.brandIntent ?? '')) {
              void props.set('brandIntent', input.value).then(accepted => { if (!accepted) input.value = value.brandIntent ?? ''; });
            }
          },
        })),
      h('div', { className: 'strong-settings__footer' },
        h('button', { type: 'button', disabled, onClick: () => { void props.reset(); } }, t('reset')),
        h('div', { className: `strong-settings__status${state.error ? ' strong-settings__error' : ''}`, role: state.error ? 'alert' : 'status', 'aria-live': 'polite' },
          state.saving ? t('saving') : state.error ? (EN[state.error] ? t(state.error) : state.error) : state.notice ? t(state.notice) : '')));
  };
}
