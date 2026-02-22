/**
 * 日志解析模块
 *
 * 负责：
 * - 解析 Claude 日志格式（位于 ~/.claude/projects 目录下）
 * - 解析 Codex 日志格式（位于 ~/.codex/sessions 目录下）
 * - 提取 Token 使用数据
 *
 * @module store/logParser
 */

/**
 * 解析 Claude 日志行
 * Claude 日志格式：包含 message.usage 字段
 * @param {string} line - JSONL 行
 * @returns {object|null} 解析后的记录 {timestamp, model, messageId, input, output, cacheRead, cacheCreate}
 */
export function parseClaudeLog(line) {
  try {
    const data = JSON.parse(line);

    // 检查是否有 usage 字段（在 message 对象内）
    if (!data.message?.usage) {
      return null;
    }

    const usage = data.message.usage;
    const timestamp = data.timestamp || data.message.timestamp;

    // 提取模型名称
    const rawModel = data.message.model || 'unknown';
    const { provider } = extractProviderAndModel(rawModel);

    // 标准化模型名称（移除版本号后缀，统一为系列名称）
    const model = normalizeModelName(rawModel);
    const messageId = typeof data.message.id === 'string' ? data.message.id : null;

    return {
      timestamp: timestamp ? new Date(timestamp) : null,
      model,
      rawModel,
      provider: provider || null,
      source: 'claude',
      messageId,
      input: usage.input_tokens || 0,
      output: usage.output_tokens || 0,
      cacheRead: usage.cache_read_input_tokens || usage.cache_read_tokens || 0,
      cacheCreate: usage.cache_creation_input_tokens || usage.cache_creation_tokens || 0,
    };
  } catch (error) {
    // 静默处理解析失败
    return null;
  }
}

/**
 * 解析 Codex 日志行
 * Codex 日志格式：包含 type=event_msg, payload.type=token_count
 * @param {string} line - JSONL 行
 * @returns {object|null} 解析后的记录 {timestamp, model, input, output, cacheRead, cacheCreate}
 */
export function parseCodexLog(line) {
  try {
    const data = JSON.parse(line);

    // 只处理 token_count 类型的事件
    if (data.type !== 'event_msg' || data.payload?.type !== 'token_count') {
      return null;
    }

    // 提取 token 使用数据
    const info = data.payload.info;
    if (!info) {
      return null;
    }

    // Codex 使用 last_token_usage 表示单次请求
    const usage = info.last_token_usage || info.total_token_usage;
    if (!usage) {
      return null;
    }

    const timestamp = data.timestamp;

    // Codex 通常使用 openai 模型，但需要根据日志中的 model_provider 推断
    // 默认标记为 codex，后续可根据 provider 细化
    const model = 'codex';

    return {
      timestamp: timestamp ? new Date(timestamp) : null,
      model,
      rawModel: 'codex',
      provider: null,
      source: 'codex',
      input: usage.input_tokens || 0,
      output: usage.output_tokens || 0,
      cacheRead: usage.cached_input_tokens || 0,
      cacheCreate: 0, // Codex 日志中未明确区分 cache_create
    };
  } catch (error) {
    // 静默处理解析失败
    return null;
  }
}

/**
 * 解析 Codex token_count 的累计快照
 * @param {string} line - JSONL 行
 * @returns {object|null} 解析后的累计快照 {timestamp, model, inputTotal, outputTotal, cacheReadTotal, totalTokens}
 */
export function parseCodexTokenSnapshot(line) {
  try {
    const data = JSON.parse(line);

    // 只处理 token_count 类型的事件
    if (data.type !== 'event_msg' || data.payload?.type !== 'token_count') {
      return null;
    }

    const info = data.payload.info;
    if (!info?.total_token_usage) {
      return null;
    }

    const totalUsage = info.total_token_usage;
    const inputTotal = toSafeInt(totalUsage.input_tokens);
    const outputTotal = toSafeInt(totalUsage.output_tokens);
    const cacheReadTotal = toSafeInt(totalUsage.cached_input_tokens);
    const totalTokens = toSafeInt(totalUsage.total_tokens) || (inputTotal + outputTotal + cacheReadTotal);

    return {
      timestamp: data.timestamp ? new Date(data.timestamp) : null,
      model: 'codex',
      inputTotal,
      outputTotal,
      cacheReadTotal,
      totalTokens
    };
  } catch (error) {
    // 静默处理解析失败
    return null;
  }
}

/**
 * 从原始模型名中提取 provider 前缀
 * 如 "minimax/minimax-m2.1" → { provider: "minimax", modelPart: "minimax-m2.1" }
 * 如 "Pro/MiniMaxAI/MiniMax-M2.5" → { provider: "Pro/MiniMaxAI", modelPart: "MiniMax-M2.5" }
 * 如 "claude-opus-4-6" → { provider: null, modelPart: "claude-opus-4-6" }
 * @param {string} rawModel - 原始模型名
 * @returns {{ provider: string|null, modelPart: string }}
 */
function extractProviderAndModel(rawModel) {
  if (!rawModel || typeof rawModel !== 'string') {
    return { provider: null, modelPart: rawModel || '' };
  }

  // "custom:" 前缀是 Droid 特有的，不算 provider
  if (rawModel.startsWith('custom:')) {
    return { provider: null, modelPart: rawModel };
  }

  // 按最后一个 "/" 拆分：前面是 provider，后面是模型名
  const lastSlash = rawModel.lastIndexOf('/');
  if (lastSlash > 0 && lastSlash < rawModel.length - 1) {
    return {
      provider: rawModel.substring(0, lastSlash),
      modelPart: rawModel.substring(lastSlash + 1)
    };
  }

  return { provider: null, modelPart: rawModel };
}

/**
 * 标准化模型名称
 * 将完整模型名称转换为系列名称（如 claude-sonnet-4-5-20250929 -> sonnet）
 * @param {string} model - 原始模型名称
 * @returns {string} 标准化后的模型名称
 */
function normalizeModelName(model) {
  if (!model || typeof model !== 'string') {
    return 'unknown';
  }

  // 先去掉 provider 前缀再匹配
  const { modelPart } = extractProviderAndModel(model);
  const lowerModel = modelPart.toLowerCase();

  // Claude 模型系列
  if (lowerModel.includes('claude-opus') || lowerModel.includes('opus')) {
    return 'opus';
  }
  if (lowerModel.includes('claude-sonnet') || lowerModel.includes('sonnet')) {
    return 'sonnet';
  }
  if (lowerModel.includes('claude-haiku') || lowerModel.includes('haiku')) {
    return 'haiku';
  }
  if (lowerModel.includes('claude')) {
    return 'claude';
  }

  // GPT 模型系列
  if (lowerModel.includes('gpt-5') || lowerModel.includes('gpt5')) {
    return 'gpt-5';
  }
  if (lowerModel.includes('gpt-4o')) {
    return 'gpt-4o';
  }
  if (lowerModel.includes('gpt-4')) {
    return 'gpt-4';
  }
  if (lowerModel.includes('gpt-3.5') || lowerModel.includes('gpt3')) {
    return 'gpt-3.5';
  }

  // MiniMax 模型系列
  if (lowerModel.includes('minimax')) {
    return 'minimax';
  }

  // GLM 模型系列（智谱）
  if (lowerModel.includes('glm')) {
    return 'glm';
  }

  // Gemini 模型系列
  if (lowerModel.includes('gemini')) {
    return 'gemini';
  }

  // 其他模型
  if (lowerModel.includes('kimi')) {
    return 'kimi';
  }
  if (lowerModel.includes('deepseek')) {
    return 'deepseek';
  }
  if (lowerModel.includes('qwen')) {
    return 'qwen';
  }
  if (lowerModel.includes('yi')) {
    return 'yi';
  }
  if (lowerModel.includes('llama')) {
    return 'llama';
  }
  if (lowerModel.includes('mistral')) {
    return 'mistral';
  }

  // 返回原始名称（去除版本号）
  return lowerModel.split(':')[0].split('-').slice(0, 2).join('-');
}

/**
 * 计算总 Token 数
 * 公式：总 Token = 输入 + 输出 + cache_read + cache_create
 * @param {object} record - 解析后的记录
 * @returns {number} 总 Token 数
 */
export function calculateTotalTokens(record) {
  return record.input + record.output + record.cacheRead + record.cacheCreate;
}

/**
 * 判断记录是否在时间窗口内
 * @param {object} record - 解析后的记录
 * @param {Date} start - 开始时间
 * @param {Date} end - 结束时间
 * @returns {boolean} 是否在窗口内
 */
export function isInTimeWindow(record, start, end) {
  if (!record.timestamp || !(record.timestamp instanceof Date)) {
    return false;
  }
  return record.timestamp >= start && record.timestamp <= end;
}

/**
 * 解析 Droid (Kiro/Factory) settings.json 数据
 * Droid 的用量存储在会话级别的 settings.json 中，包含累计 tokenUsage 快照
 * @param {object} data - settings.json 解析后的对象
 * @returns {object|null} 解析后的记录 {model, input, output, cacheRead, cacheCreate}
 */
export function parseDroidSettings(data) {
  try {
    if (!data || !data.tokenUsage) {
      return null;
    }

    const usage = data.tokenUsage;
    const inputTokens = toSafeInt(usage.inputTokens);
    const outputTokens = toSafeInt(usage.outputTokens);
    const cacheReadTokens = toSafeInt(usage.cacheReadTokens);
    const cacheCreationTokens = toSafeInt(usage.cacheCreationTokens);
    const total = inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens;

    // 过滤零用量会话
    if (total <= 0) {
      return null;
    }

    // 提取模型名称并标准化
    const rawModel = data.model || 'droid';
    const model = normalizeDroidModelName(rawModel);

    return {
      model,
      rawModel,
      provider: null,
      source: 'droid',
      input: inputTokens,
      output: outputTokens,
      cacheRead: cacheReadTokens,
      cacheCreate: cacheCreationTokens,
    };
  } catch {
    return null;
  }
}

/**
 * 标准化 Droid 模型名称
 * Droid 模型名格式如 "custom:Opus-4.6-Kiro-[duojie.games]-0"、"claude-opus-4-6" 等
 * 需要映射到与 Claude/Codex 一致的系列名称
 * @param {string} model - 原始模型名称
 * @returns {string} 标准化后的模型名称
 */
function normalizeDroidModelName(model) {
  if (!model || typeof model !== 'string') {
    return 'droid';
  }

  const lowerModel = model.toLowerCase();

  // 去掉 "custom:" 前缀
  const cleaned = lowerModel.replace(/^custom:/, '');

  // Claude 模型系列
  if (cleaned.includes('opus')) return 'opus';
  if (cleaned.includes('sonnet')) return 'sonnet';
  if (cleaned.includes('haiku')) return 'haiku';
  if (cleaned.includes('claude')) return 'claude';

  // GPT 模型系列
  if (cleaned.includes('gpt-5') || cleaned.includes('gpt5')) return 'gpt-5';
  if (cleaned.includes('gpt-4o')) return 'gpt-4o';
  if (cleaned.includes('gpt-4')) return 'gpt-4';
  if (cleaned.includes('gpt-3.5') || cleaned.includes('gpt3')) return 'gpt-3.5';

  // MiniMax 模型系列
  if (cleaned.includes('minimax')) return 'minimax';

  // GLM 模型系列（智谱）
  if (cleaned.includes('glm')) return 'glm';

  // Gemini 模型系列
  if (cleaned.includes('gemini')) return 'gemini';

  // 其他模型
  if (cleaned.includes('deepseek')) return 'deepseek';
  if (cleaned.includes('kimi')) return 'kimi';
  if (cleaned.includes('qwen')) return 'qwen';
  if (cleaned.includes('llama')) return 'llama';
  if (cleaned.includes('mistral')) return 'mistral';

  // 无法识别时标记为 droid
  return 'droid';
}

/**
 * 安全转换为整数
 * @param {unknown} value - 任意输入
 * @returns {number} 整数，非法值返回 0
 */
function toSafeInt(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Math.max(0, Math.floor(parsed));
}
