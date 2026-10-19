import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/ui/dialog";

interface BackgroundStatus {
  supported: boolean;
  enabled: boolean;
  role: "local" | "client" | "server";
  login: boolean;
  error: string | null;
  needsRestart: boolean;
  connected: boolean;
}

export function BackgroundControl() {
  const [status, setStatus] = useState<BackgroundStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<boolean | "reconnect" | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let disposed = false;
    const refresh = () => {
      void invoke<BackgroundStatus | null>("background_status")
        .then((value) => {
          if (!disposed) setStatus(value);
        })
        .catch((e) => {
          if (!disposed) setError(String(e));
        });
    };
    refresh();
    const timer = window.setInterval(refresh, 3000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, []);
  const apply = async () => {
    if (confirm === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (confirm !== "reconnect") await invoke("background_configure", { enabled: confirm });
      await invoke("background_restart");
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };
  return (
    <section aria-label="独立后台服务" className="rounded-md border border-border p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">独立后台服务</span>
        {status?.supported && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => setConfirm(!status.enabled)}
          >
            {status.enabled ? "停用并重启" : "启用并重启"}
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {status?.supported === false
          ? "独立后台目前支持 Windows 和 macOS。"
          : status?.error
            ? "后台当前不可用，任务不会转移到主程序执行。"
            : status?.enabled
              ? status.role === "client" && !status.connected
                ? "正在连接独立后台，尚未确认可执行。"
                : "已启用：关闭主界面后，提醒和已授权的 Agent 检查仍由独立进程执行。"
              : "当前随应用运行；启用后，关闭主界面仍会继续提醒和执行已授权的 Agent 检查。"}
        {status?.enabled &&
          (status.login ? " 已注册登录启动。" : " 当前未注册登录启动（开发版默认不注册）。")}
        {status?.needsRestart && " 配置切换后需要重启主界面。"}
      </p>
      {(error || status?.error) && (
        <p role="alert" className="text-xs text-destructive break-words">
          {error || status?.error}
        </p>
      )}
      {status?.role === "client" && status.error && (
        <Button variant="outline" size="sm" disabled={busy} onClick={() => setConfirm("reconnect")}>
          重启界面重新连接
        </Button>
      )}
      <Dialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirm(null);
        }}
      >
        <DialogContent>
          <DialogTitle>
            {confirm === "reconnect"
              ? "重启界面重新连接"
              : confirm
                ? "启用独立后台并重启"
                : "停止后台并重启"}
          </DialogTitle>
          <DialogDescription>
            {confirm === "reconnect"
              ? "只重启主界面，后台任务继续运行。重启后重新加载完整会话和待处理审批；请先保存未发送的草稿。版本不一致时，需要先停用旧后台再重新启用。"
              : confirm
                ? "切换会中断当前运行的 Agent 回合；已有工具效果不会撤销，未确定结果的检查需要核对。重启后的 Agent 会话由独立后台管理，关闭主界面后仍可能消耗厂商额度；新的权限请求仍需你确认。正式版会在登录后自动启动。电脑关机或睡眠期间不会执行。请先保存未发送的草稿。"
                : "会停止后台中的 Agent 执行并移除登录启动，然后重启主界面。任务、聊天与个人记忆保留。工具可能已经产生效果，中断的检查需要核对后再恢复。"}
          </DialogDescription>
          {error && (
            <p role="alert" className="text-sm text-destructive break-words">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" disabled={busy} onClick={() => setConfirm(null)}>
              取消
            </Button>
            <Button disabled={busy} onClick={() => void apply()}>
              {busy ? "正在切换…" : "确认并重启"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
