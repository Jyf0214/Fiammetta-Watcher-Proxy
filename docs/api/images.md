# Images

## 端点

```
POST /v1/images/generations
```

## 请求参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| model | string | 否 | 图像模型名称 |
| prompt | string | 是 | 图像描述 |
| n | integer | 否 | 生成数量 (默认 1) |
| size | string | 否 | 图像尺寸 (默认 1024x1024) |

## 请求示例

```bash
curl -X POST https://example.com/v1/images/generations \
  -H "Authorization: Bearer fwp-your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "dall-e-3",
    "prompt": "A cute robot reading a book",
    "n": 1,
    "size": "1024x1024"
  }'
```

## 响应格式

```json
{
  "created": 1234567890,
  "data": [
    {
      "url": "https://...",
      "revised_prompt": "A cute robot..."
    }
  ]
}
```

## 图像编辑 / 变体

### 端点

```
POST /v1/images/edits
POST /v1/images/variations
```

### 请求参数

> 注：网关层支持 **multipart 文件上传透传**——从表单中提取 `model` 字段用于路由，原始请求字节连同 `Content-Type`（含 boundary）原样透传上游，不注入模板字段。JSON 请求体同样受支持并原样透传上游，是否可用取决于上游是否接受 JSON 格式。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| image | string | 是 | 图像文件引用（JSON 字段，内容格式取决于上游） |
| model | string | 是（edits）/ 否（variations） | 图像模型名称 |
| prompt | string | 是（edits）/ 否（variations） | 编辑指令 |
| n | integer | 否 | 生成数量 (默认 1) |
| size | string | 否 | 图像尺寸 (默认 1024x1024) |

### 请求示例

```bash
curl -X POST https://example.com/v1/images/edits \
  -H "Authorization: Bearer fwp-your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "image": "https://example.com/input.png",
    "model": "gpt-image-1",
    "prompt": "Add a red hat",
    "n": 1
  }'
```

## 下一步

