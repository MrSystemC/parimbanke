import type { Metadata, Viewport } from "next";
import "./globals.css";
import "./rebrand.css";
import "./pro-polish.css";
export const metadata: Metadata = {title:"Пар'ИМБА'нк — на своей волне",description:"Пар'ИМБА'нк — локальное вейп-комьюнити, клубные розыгрыши, игровые монеты и общение с командой.",icons:{icon:"/favicon.svg"},openGraph:{title:"Пар'ИМБА'нк — на своей волне",description:"Локальные дропы, призы и клубное сообщество.",type:"website",locale:"ru_RU"},twitter:{card:"summary",title:"Пар'ИМБА'нк — на своей волне",description:"Локальные дропы, призы и клубное сообщество."}};
export const viewport: Viewport={themeColor:"#0a0c10",colorScheme:"dark"};
export default function RootLayout({children}:Readonly<{children:React.ReactNode}>){return <html lang="ru"><body>{children}</body></html>}

