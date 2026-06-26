---
name: ui-dependency-upgrade
description: UI 依赖大版本升级策略：版本评估、依赖冲突处理、类型错误修复、构建验证
source: auto-skill
extracted_at: '2026-06-26T23:17:28.448Z'
---

# UI 依赖升级策略

## 问题背景

项目 UI 依赖需要从旧版本升级到新版本（特别是大版本升级），涉及：
- 版本兼容性评估
- 依赖冲突解决
- 类型错误修复
- 构建验证

## 升级策略

### 1. 版本评估与规划

#### 检查当前状态
```bash
# 查看所有过期依赖
npm outdated

# 查看特定包的详细信息
npm info antd@latest peerDependencies
npm info @ant-design/pro-components@latest peerDependencies
```

#### 评估破坏性变更
- **大版本升级**（如 antd 5.x → 6.x）：可能存在 API 变更、废弃功能、依赖要求变化
- **小版本升级**（如 antd 5.26 → 5.29）：通常向后兼容
- **补丁升级**（如 antd 5.26.1 → 5.26.2）：仅修复 bug，安全升级

### 2. 依赖冲突处理

#### 常见冲突类型
1. **Peer dependency 冲突**：依赖包要求特定版本的其他包
2. **版本范围不匹配**：`package.json` 中的版本范围与新版本不兼容

#### 解决策略
```bash
# 1. 检查依赖树
npm ls antd

# 2. 查看冲突详情
npm install antd@latest 2>&1 | grep "peer dependency"

# 3. 处理未使用的依赖（最佳方案）
npm uninstall @ant-design/pro-components  # 如果代码中未使用

# 4. 强制安装（最后手段，可能引入问题）
npm install antd@latest --legacy-peer-deps
```

#### 决策矩阵
| 情况 | 推荐策略 |
|------|---------|
| 依赖未在代码中使用 | 直接移除 |
| 依赖有更新版本支持新版本 | 升级依赖 |
| 依赖暂时无兼容版本 | 使用 `--legacy-peer-deps` 或等待 |

### 3. 类型错误修复

#### TypeScript 大版本升级常见问题
```bash
# 构建时捕获类型错误
npm run build 2>&1 | grep "Type error"
```

#### 常见修复模式

##### 问题：参数类型不匹配
```typescript
// ❌ 错误：TypeScript 6.x 更严格的类型检查
const publicKey = createPublicKey(privateKey);

// ✅ 修复：使用类型断言
const publicKey = createPublicKey(privateKey as unknown as Parameters<typeof createPublicKey>[0]);
```

##### 问题：弃用的 API
```typescript
// ❌ 旧版 API
const data = await response.json() as OldType;

// ✅ 新版 API
const data = await response.json() as NewType;
```

### 4. 构建验证流程

```bash
# 1. 清理缓存
rm -rf node_modules/.cache

# 2. 重新安装依赖
npm install

# 3. 类型检查
npx tsc --noEmit

# 4. 构建验证
npm run build

# 5. 运行测试（如果有）
npm test
```

## 实际案例：antd 5.x → 6.x 升级

### 步骤 1：评估影响
```bash
npm outdated  # 查看 antd 5.29.3 → 6.4.5
npm info antd@6.4.5 peerDependencies  # 需要 React >=18.0.0 ✅
npm info @ant-design/pro-components@latest peerDependencies  # 仅支持 antd 4.x/5.x ❌
```

### 步骤 2：处理依赖冲突
```bash
# 检查代码中是否使用 pro-components
grep -r "@ant-design/pro-components" src/  # 无结果

# 安全移除
npm uninstall @ant-design/pro-components
```

### 步骤 3：安装新版本
```bash
npm install antd@latest @ant-design/icons@latest motion@latest i18next@latest react-i18next@latest typescript-eslint@latest @types/node@latest typescript@latest
```

### 步骤 4：修复类型错误
```bash
# 构建发现 3 处类型错误
npm run build 2>&1 | grep "Type error"

# 修复 src/lib/auth.ts 中的 createPublicKey 调用
const publicKey = createPublicKey(privateKey as unknown as Parameters<typeof createPublicKey>[0]);
```

### 步骤 5：验证
```bash
npm run build  # ✅ 构建成功
```

## 注意事项

### 1. 升级顺序
1. 先更新小版本和补丁版本
2. 再处理大版本升级
3. 最后验证整体兼容性

### 2. 风险控制
- **备份**：升级前提交所有更改
- **分步执行**：一次升级一个主要依赖
- **回滚计划**：保留 `package.json` 和 `package-lock.json` 的备份

### 3. 测试重点
- 核心功能路径（登录、数据展示、表单提交）
- 深色/浅色模式切换
- 移动端适配
- 表单验证和错误处理

## 常见问题

### Q: 如何判断是否需要升级？
A: 使用 `npm outdated` 查看，优先考虑：
- 安全漏洞修复
- Bug 修复
- 性能改进
- 新功能需求

### Q: 升级后构建失败怎么办？
A: 按以下顺序排查：
1. 查看具体错误信息
2. 检查依赖版本兼容性
3. 修复类型错误
4. 处理废弃的 API

### Q: 如何避免未来升级困难？
A: 
- 定期进行小版本升级
- 保持依赖数量精简
- 使用 TypeScript 严格模式
- 编写单元测试覆盖核心逻辑