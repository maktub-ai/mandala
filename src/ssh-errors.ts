// Turns raw OpenSSH / remote execution failures into a sentence a person can act on.
// The original technical detail is kept on the following line so nothing is hidden.
type Hint = { test: RegExp; zh: string; en: string; ssh?: true };
const hints: Hint[] = [
  { test: /spawn ssh ENOENT/i,
    zh: "这台电脑上找不到 ssh 命令。请先安装 OpenSSH 客户端，再连接远程机器。",
    en: "The ssh command was not found on this computer. Install an OpenSSH client before connecting to remote machines." },
  { test: /Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|No (?:\S+ )?host key is known/i,
    zh: "主机指纹尚未受信任或已变化。请先在终端运行 ssh <SSH 目标>，核对并接受指纹后再试。",
    en: "The host key is not trusted yet, or it changed. Run ssh <SSH target> in a terminal, verify and accept the fingerprint, then try again.", ssh: true },
  { test: /Permission denied \(|Too many authentication failures/i,
    zh: "SSH 认证失败。Mandala 以非交互方式连接，无法输入密码或私钥口令：请用 ssh-add 把密钥加入 ssh-agent，或在 ~/.ssh/config 为该主机指定可直接使用的 IdentityFile。",
    en: "SSH authentication failed. Mandala connects non-interactively and cannot type a password or key passphrase. Add the key to ssh-agent with ssh-add, or set a usable IdentityFile for this host in ~/.ssh/config.", ssh: true },
  { test: /Could not resolve hostname|Name or service not known|nodename nor servname/i,
    zh: "找不到这台主机。请检查 SSH 目标，或确认 ~/.ssh/config 中存在这个别名。",
    en: "This host could not be found. Check the SSH target, or confirm the alias exists in ~/.ssh/config.", ssh: true },
  { test: /Connection refused|Connection timed out|Operation timed out|No route to host|Network is unreachable|SSH setup timed out|Connection closed by remote host|kex_exchange_identification/i,
    zh: "无法连接到这台机器。请确认机器已开机、网络或 VPN 可达，并且 SSH 服务正在运行。",
    en: "Could not reach this machine. Check that it is powered on, reachable over your network or VPN, and running an SSH server.", ssh: true },
  { test: /supports Linux only|Linux and Node >=|Remote Node >=/i,
    zh: "远端环境不满足要求：需要 Linux 与 Node.js 22.23.2 或更高版本。",
    en: "The remote machine does not meet the requirements: Linux with Node.js 22.23.2 or later." },
  { test: /SSH failed \(127\)|(?:^|\W)node: (?:command )?not found/i,
    zh: "远端找不到 node。SSH 非交互登录可能未加载 nvm 等配置，请确认 ssh <SSH 目标> node -v 能直接运行。",
    en: "node was not found on the remote machine. Non-interactive SSH may not load nvm or shell profiles; make sure ssh <SSH target> node -v works." },
  { test: /Remote service version differs/i,
    zh: "远端执行服务来自旧版本 Mandala。已有工作被保留；请在远端确认任务空闲后停止旧服务，再重新发送。",
    en: "The remote execution service is from another Mandala version. Existing work was preserved; once remote work is idle, stop the old service and send again." },
  { test: /Remote working directory is unavailable/i,
    zh: "远程工作目录不存在或不是文件夹。请在项目设置中检查执行机器上的路径。",
    en: "The remote working directory does not exist or is not a folder. Check the path on the execution machine in project settings." },
  { test: /did not confirm stopping/i,
    zh: "未确认远端已停止。远端任务可能仍在运行；请先在机器上核对，再开始新的工作。",
    en: "Stopping was not confirmed. Remote work may still be running; check the machine before starting more work." },
  { test: /SSH disconnected|SSH detached|SSH attach timed out|execution state is unknown|Remote event history expired|Remote service restarted|Remote service stopped|Remote execution unavailable/i,
    zh: "与执行机器的连接中断，远端任务可能仍在运行，当前状态未知。Mandala 不会自动重发；请先核对远端状态，再次发送时会自动重新连接。",
    en: "The connection to the execution machine was lost. Remote work may still be running and its state is unknown. Mandala will not resend anything; check the remote state first. Sending again reconnects automatically." },
  { test: /SSH service bundle unavailable/i,
    zh: "缺少远程执行服务产物。源码运行时请先执行 npm run build:ssh-runner。",
    en: "The remote execution service bundle is missing. When running from source, run npm run build:ssh-runner first." },
];

export function sshErrorText(language: string, message: string, host?: string): string | undefined {
  const hint = hints.find(item => item.test.test(message) && (!item.ssh || /\bssh\b/i.test(message)));
  if (!hint) return undefined;
  const text = language === "zh-CN" ? hint.zh : hint.en;
  return (host ? text.replace(/<SSH (?:目标|target)>/g, host) : text) + "\n" + message;
}
