import { UiExtensionsProvider } from './UiExtensions';
import PageErrorBoundary from './PageErrorBoundary';
import React from "react";
import { ThemeProvider } from "./ThemeProvider";
import ReactDOM from "react-dom/client";
import "./ui/tokens.css";
import "./ui/tailwind.css";
import "./ui/primitives.css";
import "./styles.css";
import PersonalAccess from "./PersonalAccess";
import PetWindow from "./PetWindow";
import DevicePreferenceStatus from "./DevicePreferenceStatus";
import { LanguageProvider } from "./i18n";
import { TooltipProvider } from './components/ui/tooltip';
// On macOS the content runs to the top of the window; only the sidebar toggle shares the traffic-light row.
// Page controls (context, side panel) stay in the content's own header, as on the web.
// The desktop pet window loads the same app at /pet and shows only the pet.
const petWindow = location.pathname === '/pet';
if (petWindow) document.documentElement.classList.add('pet-window');
if (!petWindow && (window as Window & {mandalaDesktop?:{platform:string}}).mandalaDesktop?.platform === 'darwin') {
  document.documentElement.dataset.desktop='darwin';
  const titlebar=document.createElement('div');titlebar.className='desktop-titlebar';
  const slot=document.createElement('div');slot.id='desktop-titlebar-left';titlebar.append(slot);
  document.body.prepend(titlebar);
}
ReactDOM.createRoot(document.getElementById("root")!).render(petWindow ?
  <UiExtensionsProvider><LanguageProvider><ThemeProvider><PetWindow /></ThemeProvider></LanguageProvider></UiExtensionsProvider> :
  <UiExtensionsProvider><LanguageProvider>
    <ThemeProvider><TooltipProvider><DevicePreferenceStatus /><PageErrorBoundary onRecover={path=>path?location.assign(path):location.reload()}><PersonalAccess /></PageErrorBoundary></TooltipProvider></ThemeProvider>
  </LanguageProvider></UiExtensionsProvider>,
);
