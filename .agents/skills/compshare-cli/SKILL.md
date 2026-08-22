---
name: compshare-cli
description: Manage CompShare GPU cloud resources through the compshare CLI. Use when Codex needs to install or configure compshare-cli, search GPU specifications and inventory, inspect pricing, create or manage instances, connect over SSH, transfer files, run durable remote jobs, manage images, disks, US3, teams or billing, ask product questions, or diagnose CLI problems.
---

# CompShare CLI

Manage CompShare GPU compute from the terminal with the `compshare` command.

## Operating rules

- Use `compshare --json ...` for automation. Parse the single JSON document instead of terminal tables.
- Run `compshare --json COMMAND --help` before using an unfamiliar command or option. JSON help returns the current command, parameter and subcommand structure without requiring credentials.
- Put global options before the command group, for example `compshare --json --profile production instance list --all`.
- Inspect resources and prices before changing them. Use `instance create --dry-run` before a real create operation.
- Add `--yes` only when the user has authorized the mutation. Deletion, stopping, reinstalling, resizing and similar operations can require confirmation.
- Use explicit timeouts for creation, lifecycle waits and remote jobs. After a timeout, inspect the resource before retrying because the remote operation may still be running.
- Keep sensitive output redacted. Do not use `--show-sensitive` unless the user explicitly needs the raw password, IP, access URL or login command.
- Do not print, log or commit API credentials. Prefer an existing profile or environment variables over passing a private key on the command line.

## Install and configure

```bash
pip install compshare-cli
pip install --upgrade compshare-cli
```

Configure a credential profile interactively:

```bash
compshare config --name default
compshare config list
compshare --json doctor
```

For non-interactive environments, provide credentials through the process environment:

```bash
export COMPSHARE_PUBLIC_KEY='...'
export COMPSHARE_PRIVATE_KEY='...'
compshare --json doctor
```

Select a named profile with `--profile NAME`. Use `compshare config path` to locate the configuration file and `compshare config use NAME` to change the default profile.

## Discover current commands

Prefer the CLI's structured help over guessing flags:

```bash
compshare --json --help
compshare --json instance --help
compshare --json instance create --help
compshare --json image list --help
```

Global options:

- `--json`: emit the stable machine-readable response envelope.
- `--profile NAME`: select a credential profile.
- `--lang zh|en`: select the output language; JSON error codes remain language-independent.
- `--show-sensitive`: reveal normally redacted fields; avoid by default.
- `--version`: print the CLI version.

## Create an instance

Discover locations and images, then search legal specifications and real inventory:

```bash
compshare --json instance zones
compshare --json image list \
  --source platform \
  --region cn-sh2 \
  --zone cn-sh2-02 \
  --all
compshare --json instance search \
  --region cn-sh2 \
  --zone cn-sh2-02 \
  --gpu 4090 \
  --image IMAGE_ID \
  --available
```

`--image` makes `instance search` check real inventory. Without it, the command lists legal specifications only. Search does not filter CPU or memory; validate the exact CPU and memory combination with the create dry run.

Build and inspect the create plan without changing resources:

```bash
compshare --json instance create \
  --region cn-sh2 \
  --zone cn-sh2-02 \
  --gpu 4090 \
  --count 1 \
  --cpu 16 \
  --memory 64GiB \
  --image IMAGE_ID \
  --image-source platform \
  --disk 100GiB \
  --charge Postpay \
  --max-count 1 \
  --max-price 20 \
  --dry-run
```

Review the returned selection, capacity, price and request. If the user approves it, rerun without `--dry-run` and add `--yes` plus an explicit timeout:

```bash
compshare --json instance create \
  --region cn-sh2 \
  --zone cn-sh2-02 \
  --gpu 4090 \
  --count 1 \
  --cpu 16 \
  --memory 64GiB \
  --image IMAGE_ID \
  --image-source platform \
  --disk 100GiB \
  --charge Postpay \
  --max-count 1 \
  --max-price 20 \
  --yes \
  --timeout 900
```

In JSON mode, creation cannot open the interactive wizard. Supply `--gpu`, `--count`, `--cpu`, `--memory`, `--image`, `--region` and `--zone`. Here `--count` is GPUs per instance; `--max-count` is the number of instances.

## Inspect and manage instances

```bash
# List and filter
compshare --json instance list --all
compshare --json instance list --status Running --gpu 4090 --all

# Show a full record or selected sections
compshare --json instance show INSTANCE_ID
compshare --json instance show INSTANCE_ID --status --spec --billing

# Batch lifecycle operations
compshare --json instance start INSTANCE_1 INSTANCE_2 --timeout 600
compshare --json instance stop INSTANCE_1 INSTANCE_2 --yes --timeout 600
compshare --json instance wait INSTANCE_1 INSTANCE_2 --state Running --timeout 600

# Permanently delete; add --release-disk only when attached data disks must also be deleted
compshare --json instance delete INSTANCE_ID --yes --timeout 600
```

Use the direct instance ID commands without guessing a Region or Zone; the CLI resolves the location. Batch operations report succeeded and failed instances separately and exit nonzero on partial failure.

Other instance workflows are available under:

```text
instance rename, password, reinstall, resize
instance price, resize-price, billing, refund, charge
instance network, models, ports, schedule, software, template
```

Inspect each workflow with `compshare --json instance COMMAND --help` before invoking it.

## SSH and file transfer

Use `instance ssh` for an interactive shell or a short synchronous command:

```bash
compshare instance ssh INSTANCE_ID
compshare --json instance ssh INSTANCE_ID -- nvidia-smi
compshare --json instance ssh INSTANCE_ID -- sh -lc 'cd /workspace && python train.py'
```

Always place remote command arguments after `--` so the CLI does not parse them as local options. Use `sh -lc` only when the remote command needs shell syntax such as pipes, redirects, `&&` or variable expansion.

Copy a file or directory by prefixing the remote path with `:`:

```bash
compshare --json instance cp INSTANCE_ID ./model.bin :/workspace/model.bin
compshare --json instance cp INSTANCE_ID ./dataset :/workspace/dataset
compshare --json instance cp INSTANCE_ID :/workspace/results ./results
```

The CLI automatically resolves and caches SSH connection data. Use `--refresh` after a password reset or reinstall, and `--no-cache` when cached connection data must not be used.

## Durable remote jobs

Use `instance job` for installation, training, compilation and other work that must survive a local terminal or network disconnect:

```bash
compshare --json instance job submit INSTANCE_ID \
  --name training \
  --cwd /workspace/project \
  -- python train.py --epochs 100

compshare --json instance job list INSTANCE_ID
compshare --json instance job show INSTANCE_ID JOB_ID
compshare --json instance job logs INSTANCE_ID JOB_ID --tail 200
compshare --json instance job wait INSTANCE_ID JOB_ID --timeout 3600
```

Use `--follow` for live logs. For incremental agent reads, use byte offsets from the previous JSON response:

```bash
compshare --json instance job logs INSTANCE_ID JOB_ID \
  --stdout-offset STDOUT_OFFSET \
  --stderr-offset STDERR_OFFSET \
  --limit 65536
```

Cancel or prune jobs only when authorized:

```bash
compshare --json instance job cancel INSTANCE_ID JOB_ID --yes
compshare --json instance job prune INSTANCE_ID --older-than 7d --yes
```

A job wait timeout does not cancel the remote job. Query its state before submitting replacement work.

## Images, storage and teams

Discover subcommands first, then inspect the exact operation:

```bash
compshare --json image --help
compshare --json storage --help
compshare --json storage disk --help
compshare --json team --help
```

Common entry points:

```text
image list/show/create/progress/update/delete/share/unshare/publish
storage disk list/create/attach/detach/price/resize/delete
storage us3 attach
team list/joined/show/create/update/delete/audit
team invite/member/quota/billing
```

Treat image deletion, disk deletion, disk detach/resize, quota changes and team mutations as state-changing operations. Read the current resource and request confirmation before adding `--yes` where supported.

## Product questions and diagnostics

```bash
compshare --json ask '按量实例关机以后，云硬盘还收费吗？'
compshare --json doctor
compshare feedback bug '创建实例时发生错误'
```

Use `ask` for CompShare product usage and billing questions. Use `doctor` for local configuration, authentication, network and SSH environment checks. Use `feedback` only when the user asks to send feedback; it performs an external write.

## JSON contract

Successful commands return one UTF-8 JSON document shaped like:

```json
{
  "ok": true,
  "schema_version": "1",
  "data": {}
}
```

Failures return `ok: false` with a stable `error.code`, a human-readable `error.message` and optional `error.details`. List commands place rows in `data.items` and pagination or API metadata in `meta`. Check the process exit code as well as `ok`; batch operations can fail partially.

## Troubleshooting

- Authentication or configuration failure: run `compshare --json doctor`, then inspect `compshare config list` without exposing credential values.
- No available specification: search again with the exact image and `--available`; relax GPU, Region, Zone, CPU, memory, billing or disk constraints deliberately.
- JSON creation asks for interaction: provide all seven required automation options listed in the create section.
- SSH option parsed by the CLI: insert `--` before the remote command.
- Long SSH command interrupted: resubmit it as an `instance job` rather than retrying synchronously.
- Lifecycle or job timeout: inspect current state before retrying; do not assume the remote operation stopped.
- Unexpected option or output: query `compshare --json COMMAND --help` and follow the installed version rather than this reference.
