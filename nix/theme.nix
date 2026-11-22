# Exposes the hugo-bearblog flake input as the site's theme.
{ inputs, ... }:
{
  perSystem = {
    devShellHooks = ''
      mkdir -p themes
      ln -sfT ${inputs.hugo-theme} themes/main
    '';
  };
}
