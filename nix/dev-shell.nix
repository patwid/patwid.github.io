{ inputs, ... }:
{
  perSystem =
    { pkgs, self', ... }:
    {
      devShells.default = pkgs.mkShellNoCC {
        packages = [ pkgs.hugo ];
        shellHook = ''
          mkdir -p themes
          ln -sfT ${inputs.hugo-theme} themes/main
          mkdir -p generated
          ln -sfT ${self'.packages.icons} generated/icons
        '';
      };
    };
}
