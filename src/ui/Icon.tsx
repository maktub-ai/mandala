import { Mic, ChevronLeft, GripVertical, Keyboard, Files, FileUp, Plug, PanelLeft, Paperclip, GitBranch, PanelRight, Image, LayoutGrid, Pin, PinOff, Circle, CircleCheck, Activity, ArrowDown, ArrowDownWideNarrow, ArrowLeft, ArrowRight, ArrowUp, BookOpen, Check, ChevronDown, ChevronRight, CircleAlert, Clock, Code2, Copy, ExternalLink, FileText, Filter, Folder, Globe, Info, Layers, Link, ListChecks, ListTodo, Menu, MessageSquare, Moon, MoreHorizontal, Pencil, Play, Plus, RefreshCw, Search, Send, Settings, ShieldCheck, Sparkles, Square, Star, Sun, Terminal, Trash2, Undo2, UserRound, Users, Webhook, Workflow, Wrench, X } from "lucide-react";
import { Bot, Brain, Store, CalendarClock, ChartColumnIncreasing, Database, Server, Network, Blocks, FlaskConical, Compass, Palette, PenTool, BriefcaseBusiness, Rocket, Target, Shield, Headphones } from "lucide-react";
import type { SVGProps } from "react";
import { Download, TextQuote, ChevronsUpDown, ChevronsDownUp, Inbox, ChartNoAxesColumn, FileArchive, FileType, FileSpreadsheet, Presentation, Music, Film } from 'lucide-react';

// Project follows the folder-with-list reference; filesystem folders retain Folder.
function ProjectSymbol(props: SVGProps<SVGSVGElement>) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M3 7V4h7l2 3h9v14H3V7Z"/><path d="M3 7h18M12 12h5M12 16h5"/>
    <circle cx="7.5" cy="12" r=".75" fill="currentColor" stroke="none"/><circle cx="7.5" cy="16" r=".75" fill="currentColor" stroke="none"/>
  </svg>;
}
const icons = {
  microphone: Mic,
  project: ProjectSymbol, market: Store, memory: Brain, schedule: CalendarClock, usage: ChartColumnIncreasing, database: Database, server: Server, network: Network, blocks: Blocks,
  flask: FlaskConical, compass: Compass, palette: Palette, penTool: PenTool, briefcase: BriefcaseBusiness,
  rocket: Rocket, target: Target, shield: Shield, headphones: Headphones,
  inbox: Inbox,
  grip: GripVertical, keyboard: Keyboard, files: Files, upload: FileUp, chart: ChartNoAxesColumn,
  archive: FileArchive, pdf: FileType, spreadsheet: FileSpreadsheet, presentation: Presentation, audio: Music, video: Film,
  plug: Plug, panelLeft: PanelLeft, paperclip: Paperclip, gitBranch: GitBranch, panel: PanelRight, image: Image, grid: LayoutGrid, star: Star, pin: Pin, pinOff: PinOff,
  circle: Circle, circleCheck: CircleCheck, terminal: Terminal, file: FileText, tool: Wrench, search: Search, plan: ListTodo, hook: Webhook,
  play: Play, error: CircleAlert, check: Check, chevronDown: ChevronDown, chevronRight: ChevronRight, chevronLeft: ChevronLeft,
  approval: ShieldCheck, plus: Plus, close: X,
  folder: Folder, agent: Bot, settings: Settings, globe: Globe, sun: Sun, moon: Moon,
  arrowLeft: ArrowLeft, download: Download, quote: TextQuote, expandAll: ChevronsUpDown, collapseAll: ChevronsDownUp, link: Link, refresh: RefreshCw, trash: Trash2, code: Code2,
  clock: Clock, users: Users, activity: Activity, copy: Copy, menu: Menu, send: Send, stop: Square,
  edit: Pencil, book: BookOpen, message: MessageSquare, "list-check": ListChecks,
  "arrow-down-wide-narrow": ArrowDownWideNarrow, "undo-2": Undo2, "chevron-down": ChevronDown,
  "chevron-right": ChevronRight, "external-link": ExternalLink, "file-text": FileText,
  layers: Layers, arrowUp: ArrowUp, arrowDown: ArrowDown, arrowRight: ArrowRight,
  sparkles: Sparkles, workflow: Workflow, info: Info, user: UserRound, rotate: RefreshCw, filter: Filter, more: MoreHorizontal,
};

export type IconName = keyof typeof icons;

export default function Icon({ name, size = 16, className, ...props }: SVGProps<SVGSVGElement> & { name: IconName; size?: number }) {
  const Component = icons[name];
  return <Component {...props} width={size} height={size} strokeWidth={1.8} aria-hidden="true" focusable="false" className={className} />;
}
