<template>
  <div>
    <div class="page-header">
      <h2 class="page-title">{{ t('logs.title') }}</h2>
      <div style="display:flex;gap:10px;align-items:center">
        <select v-model="filterJobId" class="form-select" style="width:200px" @change="load">
          <option value="">{{ t('logs.allJobs') }}</option>
          <option v-for="j in jobs" :key="j.id" :value="j.id">{{ j.name }}</option>
        </select>
        <button class="btn btn-ghost" @click="load">{{ t('common.refresh') }}</button>
      </div>
    </div>

    <div class="card">
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{{ t('logs.colTime') }}</th>
              <th>{{ t('logs.colJob') }}</th>
              <th>{{ t('logs.colAccount') }}</th>
              <th>{{ t('logs.colStatus') }}</th>
              <th>{{ t('logs.colMessage') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!logs.length">
              <td colspan="5" class="empty">{{ t('logs.noLogs') }}</td>
            </tr>
            <template v-for="l in logs" :key="l.id">
              <tr
                :style="l.jobType === 'checkin' ? 'cursor:pointer;user-select:none' : ''"
                :class="expandedId === l.id ? 'row-expanded' : ''"
                @click="l.jobType === 'checkin' ? toggleDetail(l) : undefined"
              >
                <td style="white-space:nowrap">{{ fmtDate(l.ranAt) }}</td>
                <td>
                  {{ l.jobName ?? l.jobId }}
                  <span v-if="l.jobType === 'checkin'" style="margin-left:4px;font-size:11px;color:#aaa">▾</span>
                </td>
                <td>{{ l.accountName ?? '—' }}</td>
                <td><span :class="statusBadge(l.status)">{{ t(`logs.status.${l.status}`) }}</span></td>
                <td style="max-width:320px">
                  <div style="display:flex;align-items:center;gap:8px">
                    <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">{{ l.message ?? '—' }}</span>
                    <button
                      v-if="l.status === 'running' && l.jobType === 'checkin'"
                      class="btn btn-sm btn-danger"
                      style="flex-shrink:0"
                      :disabled="stopping.has(l.id)"
                      @click.stop="stopJob(l)"
                    >{{ stopping.has(l.id) ? t('common.stopping') : t('common.stop') }}</button>
                  </div>
                </td>
              </tr>

              <!-- Detail panel — only for checkin jobs -->
              <tr v-if="l.jobType === 'checkin' && expandedId === l.id">
                <td colspan="5" style="padding:0;background:#f8f9fa;border-top:none">
                  <div style="padding:16px 20px">
                    <div v-if="detailLoading" style="color:#888;font-size:13px">
                      {{ t('logs.detail.loading') }}
                    </div>
                    <div v-else-if="!expandedDetail?.length" style="color:#888;font-size:13px">
                      {{ t('logs.detail.noDetail') }}
                    </div>
                    <div v-else>
                      <div
                        v-for="a in expandedDetail"
                        :key="a.attempt"
                        :style="expandedDetail.length > 1 ? 'margin-bottom:16px;padding-bottom:16px;border-bottom:1px solid #e5e7eb' : ''"
                      >
                        <!-- Attempt header — only shown when there were retries -->
                        <div v-if="expandedDetail.length > 1" style="font-size:11px;font-weight:600;color:#aaa;text-transform:uppercase;letter-spacing:0.05em;text-align:center;margin-bottom:10px">
                          {{ t('logs.detail.attempt').replace('{n}', String(a.attempt)) }}
                        </div>

                        <!-- Chat-style sent / received layout -->
                        <div class="chat-bg">
                        <div class="chat-log">
                          <!-- Sent: command (right) -->
                          <div class="chat-row-sent">
                            <div class="bubble-sent">{{ a.commandSent }}</div>
                          </div>

                          <!-- Received: bot response bubble + keyboard (left) -->
                          <div v-if="a.commandResponseHtml || a.hasMedia" class="chat-row-recv">
                            <div>
                              <div class="tg-bubble">
                                <img v-if="a.commandResponseImage" :src="a.commandResponseImage" class="tg-bubble-img" alt="" />
                                <div v-else-if="a.hasMedia" class="tg-bubble-img-placeholder">📷</div>
                                <div v-if="a.commandResponseHtml" class="tg-bubble-text" v-html="a.commandResponseHtml" />
                              </div>
                              <div v-if="a.availableButtons?.length" class="tg-keyboard">
                                <div v-for="(row, ri) in a.availableButtons" :key="ri" class="tg-keyboard-row">
                                  <div v-for="btn in row" :key="btn" :class="btn === a.buttonClicked ? 'tg-btn tg-btn-active' : 'tg-btn'">{{ btn }}</div>
                                </div>
                              </div>
                            </div>
                          </div>

                          <!-- Sent: which button was clicked (right) -->
                          <div v-if="a.buttonClicked" class="chat-row-sent">
                            <div>
                              <div class="bubble-sent">{{ a.buttonClicked }}</div>
                              <div v-if="a.aiDurationMs != null" class="ai-badge">AI · {{ a.aiDurationMs }}ms</div>
                            </div>
                          </div>

                          <!-- Received: bot's follow-up message after button click -->
                          <div v-if="a.buttonResponseHtml || a.buttonResponseHasMedia" class="chat-row-recv">
                            <div>
                              <div class="tg-bubble">
                                <img v-if="a.buttonResponseImage" :src="a.buttonResponseImage" class="tg-bubble-img" alt="" />
                                <div v-else-if="a.buttonResponseHasMedia" class="tg-bubble-img-placeholder">📷</div>
                                <div v-if="a.buttonResponseHtml" class="tg-bubble-text" v-html="a.buttonResponseHtml" />
                              </div>
                              <div v-if="a.buttonResponseButtons?.length" class="tg-keyboard">
                                <div v-for="(row, ri) in a.buttonResponseButtons" :key="ri" class="tg-keyboard-row">
                                  <div v-for="btn in row" :key="btn" class="tg-btn">{{ btn }}</div>
                                </div>
                              </div>
                            </div>
                          </div>

                          <!-- Received: callback answer toast as a small bubble -->
                          <div v-if="a.callbackAnswer" class="chat-row-recv">
                            <div class="bubble-callback">{{ a.callbackAnswer }}</div>
                          </div>

                          <!-- Error shown centred between bubbles -->
                          <div v-if="a.error" class="chat-error">{{ a.error }}</div>
                        </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>

      <div v-if="logs.length === 50" style="padding:12px 16px;text-align:center">
        <button class="btn btn-ghost btn-sm" @click="loadMore">{{ t('common.loadMore') }}</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { logsApi, jobsApi, type Log, type Job, type CheckinAttemptLog } from '../api/client';
import { t } from '../i18n';

const logs = ref<Log[]>([]);
const jobs = ref<Job[]>([]);
const filterJobId = ref<number | ''>('');
const offset = ref(0);

const expandedId = ref<number | null>(null);
const expandedDetail = ref<CheckinAttemptLog[] | null>(null);
const detailLoading = ref(false);
const stopping = ref(new Set<number>());
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let detailPollTimer: ReturnType<typeof setTimeout> | null = null;

onMounted(async () => {
  jobs.value = await jobsApi.list();
  await load();
});

async function load() {
  offset.value = 0;
  expandedId.value = null;
  logs.value = await logsApi.list({
    jobId: filterJobId.value === '' ? undefined : Number(filterJobId.value),
    limit: 50,
    offset: 0,
  });
}

async function loadMore() {
  offset.value += 50;
  const more = await logsApi.list({
    jobId: filterJobId.value === '' ? undefined : Number(filterJobId.value),
    limit: 50,
    offset: offset.value,
  });
  logs.value.push(...more);
}

async function stopJob(log: Log) {
  stopping.value.add(log.id);
  stopping.value = new Set(stopping.value);
  try {
    await logsApi.cancel(log.id);
    // Poll until the log is no longer running
    const poll = async () => {
      try {
        const updated = await logsApi.getOne(log.id);
        const entry = logs.value.find(l => l.id === log.id);
        if (entry) {
          entry.status = updated.status;
          entry.message = updated.message;
        }
        if (updated.status === 'running') {
          pollTimer = setTimeout(poll, 1500);
        } else {
          stopping.value.delete(log.id);
          stopping.value = new Set(stopping.value);
        }
      } catch {
        stopping.value.delete(log.id);
        stopping.value = new Set(stopping.value);
      }
    };
    poll();
  } catch {
    stopping.value.delete(log.id);
    stopping.value = new Set(stopping.value);
  }
}

function clearDetailPoll() {
  if (detailPollTimer) { clearTimeout(detailPollTimer); detailPollTimer = null; }
}

async function fetchDetail(logId: number) {
  detailLoading.value = true;
  try {
    const full = await logsApi.getOne(logId);
    if (expandedId.value !== logId) return null; // collapsed while fetching
    expandedDetail.value = full.detail ?? null;
    // Keep the row status in sync
    const entry = logs.value.find(l => l.id === logId);
    if (entry) { entry.status = full.status; entry.message = full.message; }
    return full;
  } catch {
    return null;
  } finally {
    detailLoading.value = false;
  }
}

function scheduleDetailPoll(logId: number) {
  clearDetailPoll();
  detailPollTimer = setTimeout(async () => {
    const full = await fetchDetail(logId);
    if (full?.status === 'running' && expandedId.value === logId) scheduleDetailPoll(logId);
  }, 2000);
}

async function toggleDetail(log: Log) {
  if (expandedId.value === log.id) {
    expandedId.value = null;
    expandedDetail.value = null;
    clearDetailPoll();
    return;
  }
  clearDetailPoll();
  expandedId.value = log.id;
  expandedDetail.value = null;
  const full = await fetchDetail(log.id);
  if (full?.status === 'running' && expandedId.value === log.id) scheduleDetailPoll(log.id);
}

function statusBadge(s: Log['status']) {
  const map: Record<string, string> = {
    success: 'badge badge-green',
    failed:  'badge badge-red',
    running: 'badge badge-orange',
  };
  return map[s] ?? 'badge badge-grey';
}

onUnmounted(() => {
  if (pollTimer) clearTimeout(pollTimer);
  clearDetailPoll();
});

function fmtDate(iso: string) {
  return new Date(iso).toLocaleString('en-AU', {
    month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}
</script>

<style scoped>
.row-expanded td {
  background: #f0f4ff;
}

/* Chat background container */
.chat-bg {
  display: inline-block;
  background: #eef1f5;
  border-radius: 10px;
  padding: 12px 14px;
  max-width: 420px;
  width: 100%;
  box-sizing: border-box;
}

/* Chat layout */
.chat-log {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.chat-row-sent {
  display: flex;
  justify-content: flex-end;
}
.chat-row-recv {
  display: flex;
  justify-content: flex-start;
}

/* Outgoing bubble (right) — green like Telegram */
.bubble-sent {
  background: #dcf8c6;
  border-radius: 14px 14px 4px 14px;
  padding: 8px 12px;
  font-size: 13px;
  font-family: monospace;
  color: #111;
  max-width: 75%;
  word-break: break-all;
}

/* AI selection indicator shown below the sent button bubble */
.ai-badge {
  font-size: 11px;
  color: #6366f1;
  text-align: right;
  margin-top: 3px;
  padding-right: 2px;
  font-weight: 500;
}

/* Callback answer bubble (left) — smaller, italic */
.bubble-callback {
  background: #e9e9eb;
  border-radius: 14px 14px 14px 4px;
  padding: 6px 10px;
  font-size: 12px;
  color: #333;
  max-width: 75%;
  font-style: italic;
}

/* Error shown as centred note between bubbles */
.chat-error {
  font-size: 12px;
  color: #e63946;
  text-align: center;
  padding: 2px 0;
}

/* Incoming message bubble (left) */
.tg-bubble {
  display: inline-block;
  background: #e9e9eb;
  border-radius: 14px 14px 14px 4px;
  overflow: hidden;
  max-width: 300px;
  min-width: 80px;
}
.tg-bubble-img {
  width: 100%;
  display: block;
}
.tg-bubble-img-placeholder {
  height: 80px;
  background: #d8d8da;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 22px;
}
.tg-bubble-text {
  padding: 8px 12px;
  font-size: 13px;
  line-height: 1.55;
  color: #111;
}
.tg-bubble-text a { color: #2563eb; }
.tg-bubble-text code { background: #d4d4d6; padding: 1px 4px; border-radius: 3px; font-size: 12px; }
.tg-bubble-text pre { background: #d4d4d6; padding: 8px; border-radius: 4px; overflow-x: auto; }

/* Inline keyboard sits below the incoming bubble */
.tg-keyboard {
  margin-top: 4px;
  max-width: 300px;
}
.tg-keyboard-row {
  display: flex;
  gap: 4px;
  margin-bottom: 4px;
}
.tg-btn {
  flex: 1;
  font-size: 12px;
  padding: 6px 8px;
  border-radius: 8px;
  border: 1.5px solid #d0d7de;
  background: #fff;
  color: #333;
  text-align: center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tg-btn-active {
  background: #dcf8c6;
  color: #1a7f37;
  border-color: #9ad97a;
  font-weight: 600;
}
</style>
