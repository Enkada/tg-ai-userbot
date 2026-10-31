#!/usr/bin/env bash
set -euo pipefail

# This runs on a disposable GitHub-hosted runner, never on the operator's PC.
if [[ "${GITHUB_ACTIONS:-}" != true || "${RUNNER_ENVIRONMENT:-}" != github-hosted ]]; then
  echo 'Run this through the cloud build workflow.' >&2
  exit 1
fi

: "${CHECKPOINT_URL:?}" "${LORA_URL:?}" "${CHECKPOINT_AUTHORIZATION:?}" "${LORA_AUTHORIZATION:?}" "${S3_DATE:?}" "${S3_CONTENT_SHA256:?}" "${IMAGE:?}" "${DOCKER_USERNAME:?}" "${DOCKER_TOKEN:?}"
BASE='runpod/worker-comfyui@sha256:45a1abd8796dbbcbc631f3d7d0db942946ce2f82ff24a070e3e6c527eeff9c47'
CRANE_VERSION='v0.22.1'
CRANE_SHA256='0ab7a1d6932a213aed964ce97666c3077fe691c8606413674a8b3e0b9ec4cda0'

# Reclaim an unused SDK only inside this fresh, disposable VM.
sudo rm -rf /usr/local/lib/android
df -h "$RUNNER_TEMP"
mkdir -p "$RUNNER_TEMP/tools" "$RUNNER_TEMP/layer/comfyui/models/checkpoints" "$RUNNER_TEMP/layer/comfyui/models/loras"
curl -fsSL --retry 3 "https://github.com/google/go-containerregistry/releases/download/${CRANE_VERSION}/go-containerregistry_Linux_x86_64.tar.gz" -o "$RUNNER_TEMP/crane.tar.gz"
echo "$CRANE_SHA256  $RUNNER_TEMP/crane.tar.gz" | sha256sum --check
tar -xzf "$RUNNER_TEMP/crane.tar.gz" -C "$RUNNER_TEMP/tools" crane
export PATH="$RUNNER_TEMP/tools:$PATH"

checkpoint="$RUNNER_TEMP/layer/comfyui/models/checkpoints/waiIllustriousSDXL_v160.safetensors"
lora="$RUNNER_TEMP/layer/comfyui/models/loras/ramdomrot_v2_illustrious_locon-000009.safetensors"
curl -fsSL --retry 5 --connect-timeout 20 --max-time 1800 -H "Authorization: $CHECKPOINT_AUTHORIZATION" -H "x-amz-date: $S3_DATE" -H "x-amz-content-sha256: $S3_CONTENT_SHA256" "$CHECKPOINT_URL" -o "$checkpoint"
curl -fsSL --retry 5 --connect-timeout 20 --max-time 600 -H "Authorization: $LORA_AUTHORIZATION" -H "x-amz-date: $S3_DATE" -H "x-amz-content-sha256: $S3_CONTENT_SHA256" "$LORA_URL" -o "$lora"
echo "a5f58eb1c33616c4f06bca55af39876a7b817913cd829caa8acb111b770c85cc  $checkpoint" | sha256sum --check
echo "df7e0f2feeb9292c1286ceefc065b90e58ca0ba1e852d030cb0291a0667555c6  $lora" | sha256sum --check

# Append only the model layer. Existing base layers are reused in the registry,
# avoiding a full base-image download, unpack, and rebuild.
tar --format=gnu --mtime='@0' --owner=0 --group=0 --numeric-owner -I 'gzip -1' -cf "$RUNNER_TEMP/models.tar.gz" -C "$RUNNER_TEMP/layer" comfyui
printf '%s' "$DOCKER_TOKEN" | crane auth login index.docker.io --username "$DOCKER_USERNAME" --password-stdin
crane append --platform linux/amd64 --base "$BASE" --new_layer "$RUNNER_TEMP/models.tar.gz" --new_tag "$IMAGE"
crane mutate --platform linux/amd64 "$IMAGE" --env COMFY_LOG_LEVEL=INFO --tag "$IMAGE"
digest="$(crane digest "$IMAGE")"
printf 'IMAGE_DIGEST=%s\n' "$digest"
printf 'Private worker image: `%s@%s`\n' "${IMAGE%:*}" "$digest" >> "$GITHUB_STEP_SUMMARY"
