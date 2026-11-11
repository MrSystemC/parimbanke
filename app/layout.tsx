import type { Metadata, Viewport } from "next";
import "./globals.css";
import "./rebrand.css";
export const metadata: Metadata = {title:"Пар'ИМБА'нк — на своей волне",description:"Пар'ИМБА'нк — локальное вейп-комьюнити, клубные розыгрыши, игровые монеты и общение с командой.",icons:{icon:"/favicon.svg"}};
export const viewport: Viewport={themeColor:"#0a0c10",colorScheme:"dark"};
export default function RootLayout({children}:Readonly<{children:React.ReactNode}>){return <html lang="ru"><body>{children}</body></html>}
