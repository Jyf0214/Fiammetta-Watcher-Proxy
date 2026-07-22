import type { AppProps } from 'next/app'
import '../styles/globals.css'
import { ThemeProvider, ConfigProvider } from '@lobehub/ui'
import { motion } from 'motion/react'

export default function App({ Component, pageProps }: AppProps) {
  return (
    <ConfigProvider motion={motion}>
      <ThemeProvider enableGlobalStyle>
        <Component {...pageProps} />
      </ThemeProvider>
    </ConfigProvider>
  )
}
