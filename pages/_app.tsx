import type { AppProps } from "next/app"
import Head from "next/head"
import { useRouter } from "next/router"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import "../styles/globals.css"
import "@/lib/i18n"
import { message } from "antd"
import RouteLoading from "@/components/RouteLoading"

// Toast 固定在导航栏下方，避免遮挡
message.config({ top: 60 })

export default function App({ Component, pageProps }: AppProps) {
  const router = useRouter()
  const { t } = useTranslation("common")
  const [routeLoading, setRouteLoading] = useState(false)

  // 管理后台路由切换时显示骨架屏，替代整页白屏 + 居中 Spinner
  useEffect(() => {
    const handleStart = (url: string) => {
      if (url.startsWith("/admin")) setRouteLoading(true)
    }
    const handleDone = () => setRouteLoading(false)

    router.events.on("routeChangeStart", handleStart)
    router.events.on("routeChangeComplete", handleDone)
    router.events.on("routeChangeError", handleDone)
    return () => {
      router.events.off("routeChangeStart", handleStart)
      router.events.off("routeChangeComplete", handleDone)
      router.events.off("routeChangeError", handleDone)
    }
  }, [router])

  return (
    <>
      <Head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="description" content={t("metaDescription")} />
        <title>{t("brandFull")}</title>
      </Head>
      {routeLoading && <RouteLoading />}
      <Component {...pageProps} />
    </>
  )
}
