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

> 注：网关层仅接受 **JSON 请求体**（multipart 文件上传未实现），JSON 请求体会原样透传上游——是否可用取决于上游是否接受 JSON 格式；需要文件上传的调用请直接对接上游平台。

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

