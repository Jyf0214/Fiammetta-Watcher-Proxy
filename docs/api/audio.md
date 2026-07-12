# Audio

FWP 支持三种语音相关 API 端点，全部兼容 OpenAI Audio API 格式。

## TTS 文字转语音

### 端点

```
POST /v1/audio/speech
```

### 请求参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| model | string | 是 | TTS 模型名称（如 `tts-1`、`tts-1-hd`） |
| input | string | 是 | 要转换的文本 |
| voice | string | 是 | 语音类型（`alloy`、`echo`、`fable`、`onyx`、`nova`、`shimmer`） |
| response_format | string | 否 | 输出格式（`mp3`、`opus`、`aac`、`flac`，默认 `mp3`） |
| speed | number | 否 | 语速（0.25-4.0，默认 1.0） |

### 请求示例

```bash
curl -X POST https://fwp.example.com/v1/audio/speech \
  -H "Authorization: Bearer fwp-your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "tts-1",
    "input": "Hello, this is a test.",
    "voice": "alloy"
  }' \
  --output speech.mp3
```

## 语音转文字（Whisper）

### 端点

```
POST /v1/audio/transcriptions
```

### 请求参数

该端点使用 `multipart/form-data` 格式：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| file | file | 是 | 音频文件 |
| model | string | 是 | 模型名称（如 `whisper-1`） |
| language | string | 否 | 音频语言（ISO-639-1 格式） |
| prompt | string | 否 | 提示文本 |
| response_format | string | 否 | 输出格式（`json`、`text`、`srt`、`verbose_json`、`vtt`） |

### 请求示例

```bash
curl -X POST https://fwp.example.com/v1/audio/transcriptions \
  -H "Authorization: Bearer fwp-your-api-key" \
  -F "file=@audio.mp3" \
  -F "model=whisper-1"
```

## 语音翻译

### 端点

```
POST /v1/audio/translations
```

### 请求参数

该端点使用 `multipart/form-data` 格式：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| file | file | 是 | 音频文件 |
| model | string | 是 | 模型名称（如 `whisper-1`） |
| prompt | string | 否 | 提示文本 |
| response_format | string | 否 | 输出格式 |

### 请求示例

```bash
curl -X POST https://fwp.example.com/v1/audio/translations \
  -H "Authorization: Bearer fwp-your-api-key" \
  -F "file=@audio.mp3" \
  -F "model=whisper-1"
```

## 下一步

