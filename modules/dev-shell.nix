{ inputs, ... }:
{
  perSystem =
    { pkgs, ... }:
    {
      devShells.default = pkgs.mkShellNoCC {
        packages = [ pkgs.hugo ];
        shellHook = ''
          mkdir -p themes
          ln -sfT ${inputs.hugo-theme} themes/main
        '';
      };
    };
}
