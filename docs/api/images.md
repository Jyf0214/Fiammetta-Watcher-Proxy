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

## 下一步

