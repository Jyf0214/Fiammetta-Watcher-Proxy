{ pkgs, ... }: {
 channel = "stable-24.05";
 packages = [
   pkgs.git
   pkgs.openssl
   pkgs.curl
   pkgs.gh
   pkgs.wget
   pkgs.nodejs_22
   pkgs.python313
   pkgs.docker
   pkgs.rclone     
   pkgs.sudo
   pkgs.openssh
   pkgs.cloudflared
 ];
 idx.extensions = [
   "qwenlm.qwen-code-vscode-ide-companion"
 ];
 idx.previews = {
   enable = true;
 };
 idx.workspace.onCreate = {
   install-gemini-cli = ''
     npm uninstall -g @google/gemini-cli 2>/dev/null || true
     npm install -g @google/gemini-cli
   '';
   install-qwen-code = ''
     npm uninstall -g @qwen-code/qwen-code 2>/dev/null || true
     npm install -g @qwen-code/qwen-code@latest
   '';
 };
}
