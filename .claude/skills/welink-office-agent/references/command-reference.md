# Wrapper command reference

All commands run from the project root:

```bash
node .claude/skills/welink-office-agent/scripts/agent.mjs <command>
```

## Bootstrap and inspection

```bash
node .claude/skills/welink-office-agent/scripts/agent.mjs init
node .claude/skills/welink-office-agent/scripts/agent.mjs preflight
node .claude/skills/welink-office-agent/scripts/agent.mjs status
node .claude/skills/welink-office-agent/scripts/agent.mjs status --task-id TASK-ID
node .claude/skills/welink-office-agent/scripts/agent.mjs resume
```

## Task and subtask

```bash
node .claude/skills/welink-office-agent/scripts/agent.mjs create-task --title "标题" --request "完整任务"
node .claude/skills/welink-office-agent/scripts/agent.mjs add-subtask --task-id TASK-ID --title "询问测试进度" --target-employee-number 00123456 --required-info "当前状态,阻塞问题,预计完成时间"
node .claude/skills/welink-office-agent/scripts/agent.mjs update-subtask --task-id TASK-ID --subtask-id SUB-ID --status completed --summary "已获得完整信息"
node .claude/skills/welink-office-agent/scripts/agent.mjs complete-task --task-id TASK-ID --summary "最终汇总"
```

## Dynamic item and approval

```bash
node .claude/skills/welink-office-agent/scripts/agent.mjs add-item --task-id TASK-ID --description "组织一次评审" --source-employee-number 00123456 --relation scope_extension --workload large
node .claude/skills/welink-office-agent/scripts/agent.mjs classify-item --item-id ITEM-ID --decision auto_subtask --target-employee-number 00678901 --required-info "当前状态,预计完成时间"
node .claude/skills/welink-office-agent/scripts/agent.mjs create-approval --task-id TASK-ID --item-id ITEM-ID --question "是否组织评审？" --options "纳入当前任务,创建独立任务,退回提出人,关闭"
node .claude/skills/welink-office-agent/scripts/agent.mjs resolve-approval --approval-id AP-ID --resolution returned --response "退回提出人"
```

## Messages

```bash
node .claude/skills/welink-office-agent/scripts/agent.mjs send-user --employee-number 00123456 --task-id TASK-ID --subtask-id SUB-ID --text "张哥，麻烦同步当前状态。"
node .claude/skills/welink-office-agent/scripts/agent.mjs send-group --group-id GROUP-ID --task-id TASK-ID --type progress --text "【任务进度】..."
node .claude/skills/welink-office-agent/scripts/agent.mjs query-history-user --employee-number 00123456 --count 20
node .claude/skills/welink-office-agent/scripts/agent.mjs query-history-group --group-id GROUP-ID --count 20
node .claude/skills/welink-office-agent/scripts/agent.mjs record-message --direction inbound --participant-type user --participant-id 00123456 --task-id TASK-ID --content "同事原始回复"
node .claude/skills/welink-office-agent/scripts/agent.mjs set-cursor --participant-type user --participant-id 00123456 --message-id MESSAGE-ID
```
