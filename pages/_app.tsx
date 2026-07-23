import type { AppProps } from 'next/app'
import '../styles/globals.css'
import '@/lib/i18n'
import { message } from 'antd'

// Toast 固定在导航栏下方，避免遮挡
message.config({ top: 60 })

export default function App({ Component, pageProps }: AppProps) {
  return <Component {...pageProps} />
}
