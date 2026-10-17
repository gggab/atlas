import { Input } from "@/ui/input";
import type { CalendarSpec, CalendarPreview } from "../lib/tasks-api";

export function newCalendar(frequency: CalendarSpec["frequency"]): CalendarSpec {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 10);
  return {
    frequency,
    startDate: local,
    localTime: "09:00",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? "",
    missingDayPolicy: null,
    reminderDays: [0],
    trackCompletion: true,
  };
}
export function CalendarFields({
  value,
  onChange,
  preview,
  anchorLocked,
}: {
  value: CalendarSpec;
  onChange: (value: CalendarSpec) => void;
  preview: CalendarPreview | null;
  anchorLocked: boolean;
}) {
  const update = (part: Partial<CalendarSpec>) => onChange({ ...value, ...part });
  return (
    <fieldset className="space-y-2 rounded border border-border p-2">
      <legend className="text-xs">公历周期规则</legend>
      <label className="block text-xs">
        周期起始日期
        <Input
          type="date"
          required
          value={value.startDate}
          disabled={anchorLocked}
          onChange={(e) => update({ startDate: e.target.value })}
        />
      </label>
      {anchorLocked && (
        <p className="text-xs text-muted-foreground">
          已启用计划的起始日期和频率固定；修改它们请取消并新建计划。
        </p>
      )}
      <label className="block text-xs">
        提醒钟点
        <Input
          type="time"
          required
          value={value.localTime}
          onChange={(e) => update({ localTime: e.target.value })}
        />
      </label>
      <label className="block text-xs">
        固定时区
        <Input
          value={value.timezone}
          placeholder="Asia/Shanghai"
          onChange={(e) => update({ timezone: e.target.value })}
        />
      </label>
      <p className="text-xs text-muted-foreground">
        旅行后仍使用此时区。提醒钟点不代表银行或缴费截止钟点。
      </p>
      {(value.frequency === "monthly" || value.frequency === "yearly") && (
        <label className="block text-xs">
          不存在的日期如何处理
          <select
            className="block w-full rounded border border-border bg-background p-1"
            value={value.missingDayPolicy ?? ""}
            onChange={(e) =>
              update({
                missingDayPolicy: (e.target.value || null) as CalendarSpec["missingDayPolicy"],
              })
            }
          >
            <option value="">尚未确定（需要时保存为待确认）</option>
            <option value="last_day">当月最后一天</option>
            <option value="skip">跳过该期</option>
            {value.frequency === "yearly" && <option value="next_day">2月29日顺延至3月1日</option>}
          </select>
        </label>
      )}
      <label className="block text-xs">
        提前提醒天数（逗号分隔，包含0表示当天）
        <Input
          required
          pattern="[0-9]+( *, *[0-9]+)*"
          defaultValue={value.reminderDays.join(",")}
          key={`${value.frequency}-${anchorLocked}`}
          onChange={(e) =>
            update({
              reminderDays: e.target.value.trim()
                ? e.target.value.split(",").map((v) => Number(v.trim()))
                : [],
            })
          }
        />
      </label>
      <label className="block text-xs">
        结束日期（含当天，可留空）
        <Input
          type="date"
          value={value.untilDate ?? ""}
          onChange={(e) => update({ untilDate: e.target.value || null })}
        />
      </label>
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={value.trackCompletion}
          onChange={(e) => update({ trackCompletion: e.target.checked })}
        />
        每期需要确认完成（账单、缴费、待办）
      </label>
      <p className="text-xs text-muted-foreground">
        关闭后适用于生日等信息提醒，日期过去后显示“已过期”，不会标记为已缴费。
      </p>
      {preview && (
        <div aria-label="周期预览" className="space-y-1 text-xs">
          {preview.issues.map((i) => (
            <p role="status" key={i.field}>
              {i.question}
            </p>
          ))}
          {preview.issues.length > 0 && <p>此计划只能保存为待确认，不会执行。</p>}
          {preview.periods.map((p) => (
            <div key={p.index}>
              <p>
                {p.localDate}（{p.timezone}）
              </p>
              <p className="text-muted-foreground">
                {p.reminders
                  .map(
                    (r) =>
                      `${r.leadDays === 0 ? "当天" : `提前${r.leadDays}天`} ${new Date(r.at).toLocaleString("zh-CN", { timeZone: p.timezone })}`,
                  )
                  .join("；") || "本期没有待发送提醒（已处理或已发送）。"}
              </p>
            </div>
          ))}
          {preview.frozenPeriods.length > 0 && (
            <p>
              以下各期已经开始或处理，继续使用原规则：{preview.frozenPeriods.join("、")}
              。新规则仅作用于尚未开始的后续各期。
            </p>
          )}
          <p className="text-muted-foreground">{preview.dstPolicy}</p>
          <p className="text-muted-foreground">
            创建前的历史各期不补建，已经过去的提前提醒会跳过。农历及节假日顺延暂不支持。
          </p>
        </div>
      )}
    </fieldset>
  );
}
