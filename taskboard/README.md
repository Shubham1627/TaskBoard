# TaskBoard: a Kubernetes-free full-stack app

A small task manager built so that **every Kubernetes feature you want to learn has something real to attach to**.
Right now it runs on one plain Linux VM with no containers. Later you containerize it, piece by piece.

## Architecture (on the VM)

```
Browser ──80──> nginx ──┬── static files (frontend/: index.html, app.js, config.js)
                        └── /api/* ──> Node.js backend :3000 ──┬──> PostgreSQL :5432  (tasks)
                                       (systemd service)       ├──> Redis :6379       (cache + shared counter)
                                                               └──> local disk        (file attachments)
cron (nightly) ──> scripts/cleanup.js     one-shot: scripts/migrate.js
```

## Layout

```
backend/    Node.js + Express API (src/), one-shot scripts (scripts/), .env.example
frontend/   plain HTML/CSS/JS, no build step; config.js is runtime configuration
deploy/     setup-vm.sh, nginx.conf, taskboard-backend.service, run-job.sh
```

## Deploy on a VM (Ubuntu 22.04 / 24.04, needs internet)

```bash
unzip taskboard.zip && cd taskboard
sudo ./deploy/setup-vm.sh          # installs Node 20, PostgreSQL, Redis, nginx; creates users, config, service
```
Open `http://<vm-ip>/` (allow port 80 in the firewall or cloud security group).

Check it works:
```bash
curl -s localhost/api/info
curl -s -X POST localhost/api/tasks -H 'Content-Type: application/json' -d '{"title":"first task"}'
curl -s localhost/api/tasks
curl -s localhost:3000/readyz                       # backend health, straight to the app
sudo journalctl -u taskboard-backend -f             # JSON logs
sudo systemctl restart taskboard-backend            # sends SIGTERM: watch the graceful shutdown in the logs
```
Try breaking things on purpose: `sudo systemctl stop redis-server` (app keeps working, cache off),
`sudo systemctl stop postgresql` (`/readyz` returns 503), and
`curl -X POST localhost/api/admin/crash -H "x-api-key: <ADMIN_API_KEY>"` (systemd restarts it).

## Where things are configured today, and where they go in Kubernetes

| Today on the VM | Kubernetes concept later |
|---|---|
| `/etc/taskboard/app.env` (plain settings) | **ConfigMap** (as env vars) |
| `/etc/taskboard/secrets.env` (DB/Redis passwords, admin key) | **Secret** |
| `frontend/config.js` (runtime UI settings, banner text) | ConfigMap **mounted as a file**: change the UI without rebuilding the image |
| nginx + Node + PostgreSQL + Redis, each its own process | one **Deployment** each (PostgreSQL as a **StatefulSet**), joined by **Services** |
| `/api/info` shows the answering `hostname` | **replicas**: the hostname becomes the pod name; watch load balancing and rolling updates (`APP_VERSION`) |
| `/healthz` and `/readyz` | **liveness / readiness / startup probes** |
| SIGTERM handling in `server.js` | rolling updates, `terminationGracePeriodSeconds`, `preStop` |
| PostgreSQL data directory | **PersistentVolumeClaim**, StorageClass |
| `UPLOAD_DIR` (attachments on local disk) | a second PVC, and the classic trap: several replicas + a ReadWriteOnce volume (uploads land on one pod only). Solutions: RWX volume or object storage |
| `scripts/migrate.js` | **initContainer** or **Job** |
| cron + `scripts/cleanup.js` | **CronJob** (it needs the uploads volume too) |
| `/api/load` (CPU burn) and `/metrics` | **resource requests/limits**, **HorizontalPodAutoscaler**, Prometheus |
| `/api/admin/crash` | restart policy, CrashLoopBackOff |
| JSON logs on stdout | `kubectl logs`, log collectors |
| nginx `location /api/` rule | **Ingress** (path routing), TLS |
| `ENABLE_UPLOADS`, `ENABLE_LOAD_ENDPOINT` | feature flags via ConfigMap; rollout on config change |

Later extras that fit naturally: Namespaces, ResourceQuota, NetworkPolicy (only the backend may reach PostgreSQL),
ServiceAccount and RBAC, PodDisruptionBudget, Kustomize or Helm.

## Suggested learning path

1. **Run it on the VM** (this step) and read the code once. Know what each piece does.
2. **Containers:** write a Dockerfile for the backend and one for nginx + frontend; run all four parts with `docker compose`.
3. **First cluster:** kind or minikube. Pods, then Deployments and Services, one component at a time.
4. **Config:** move `app.env` to a ConfigMap and `secrets.env` to a Secret; mount `config.js`.
5. **State:** PostgreSQL as a StatefulSet with a PVC; try deleting the pod and check the data survives.
6. **Traffic:** Ingress; scale the backend to 3 replicas and watch the "Answered by" panel.
7. **Reliability:** probes, resource limits, HPA (press "Burn CPU"), rolling update, deliberate crash.
8. **Jobs:** migration Job, cleanup CronJob.
9. **Packaging:** Kustomize or Helm.

## Notes

- Backend listens on `127.0.0.1` on the VM (`HOST`); inside a container it must be `0.0.0.0` (the code default).
- The attachment and load features are intentionally simple: they exist to be scaled, mounted and stressed.
- This is a learning project: no user accounts and no HTTPS. Add TLS (Ingress + cert-manager) later.
