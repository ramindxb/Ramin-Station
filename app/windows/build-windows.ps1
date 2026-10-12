$ErrorActionPreference = "Stop"

$RootDir = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$AppSource = Join-Path $RootDir "app"
$WindowsSource = Join-Path $AppSource "windows"
$WebTarget = Join-Path $WindowsSource "web"
$DistDir = Join-Path $RootDir "dist"
$AppExe = Join-Path $DistDir "Ramin Station.exe"
$SetupExe = Join-Path $DistDir "Ramin-Station-2.0-Windows-Setup.exe"
$PortableZip = Join-Path $DistDir "Ramin-Station-2.0-Windows-Portable.zip"
$InstallerPayload = Join-Path $WindowsSource "installer/payload"

New-Item -ItemType Directory -Force -Path (Join-Path $WebTarget "assets"), $DistDir, (Join-Path $InstallerPayload "licenses") | Out-Null
Copy-Item (Join-Path $AppSource "*.html") $WebTarget -Force
Copy-Item (Join-Path $AppSource "*.css") $WebTarget -Force
Copy-Item (Join-Path $AppSource "*.js") $WebTarget -Force
Copy-Item (Join-Path $AppSource "assets/*") (Join-Path $WebTarget "assets") -Recurse -Force

Push-Location $WindowsSource
try {
    gofmt -w main.go installer/main.go
    go mod tidy
    $env:GOOS = "windows"
    $env:GOARCH = "amd64"
    $env:CGO_ENABLED = "0"
    go build -trimpath -ldflags="-H windowsgui -s -w" -o $AppExe .

    $PortableStage = Join-Path ([System.IO.Path]::GetTempPath()) ("ramin-station-" + [guid]::NewGuid())
    New-Item -ItemType Directory -Force -Path $PortableStage | Out-Null
    try {
        Copy-Item $AppExe (Join-Path $PortableStage "Ramin Station.exe")
        Copy-Item (Join-Path $WindowsSource "README-Windows.txt") (Join-Path $PortableStage "README.txt")
        Copy-Item (Join-Path $AppSource "licenses") (Join-Path $PortableStage "licenses") -Recurse
        if (Test-Path $PortableZip) { Remove-Item $PortableZip -Force }
        Compress-Archive -Path (Join-Path $PortableStage "*") -DestinationPath $PortableZip -CompressionLevel Optimal
    }
    finally {
        Remove-Item $PortableStage -Recurse -Force -ErrorAction SilentlyContinue
    }

    Copy-Item $AppExe (Join-Path $InstallerPayload "Ramin Station.exe") -Force
    Copy-Item (Join-Path $AppSource "licenses/*") (Join-Path $InstallerPayload "licenses") -Force
    go build -trimpath -ldflags="-H windowsgui -s -w" -o $SetupExe ./installer
}
finally {
    Pop-Location
    Remove-Item Env:GOOS, Env:GOARCH, Env:CGO_ENABLED -ErrorAction SilentlyContinue
}

Write-Output $AppExe
Write-Output $PortableZip
Write-Output $SetupExe
