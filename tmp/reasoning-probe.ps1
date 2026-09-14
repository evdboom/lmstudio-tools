$h = @{ Authorization = "Bearer $env:LMSTUDIO_API_TOKEN"; "Content-Type" = "application/json" }
$instructions = "You are an expert fiction writer. Before writing, reason about the task in your internal reasoning channel. Your response contains the final prose only."

function Run($label, $input) {
  $body = @{
    model = "qwen3.8-27b"
    input = $input
    instructions = $instructions
    stream = $true
    store = $false
    max_output_tokens = 120
  } | ConvertTo-Json -Depth 6

  $req = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:1234/v1/responses")
  $req.Method = "POST"
  $req.ContentType = "application/json"
  $req.Headers.Add("Authorization", "Bearer $env:LMSTUDIO_API_TOKEN")
  $bytes = [Text.Encoding]::UTF8.GetBytes($body)
  $req.ContentLength = $bytes.Length
  $s = $req.GetRequestStream(); $s.Write($bytes, 0, $bytes.Length); $s.Close()
  $reader = New-Object IO.StreamReader($req.GetResponse().GetResponseStream())
  $reasoning = 0; $text = 0
  while (-not $reader.EndOfStream) {
    $line = $reader.ReadLine()
    if ($line -like "data: *" -and $line -notlike "data: [DONE]") {
      $o = $line.Substring(6) | ConvertFrom-Json
      if ($o.type -eq "response.reasoning_text.delta") { $reasoning++ }
      if ($o.type -eq "response.output_text.delta") { $text++ }
    }
  }
  "$label -> reasoning deltas=$reasoning  text deltas=$text"
}

$noExample = @(
  @{ role = "user"; content = "Write two sentences about rain on a harbour." }
)
$withExample = @(
  @{ role = "user"; content = "Write two sentences about snow on a harbour." },
  @{ role = "assistant"; content = "Snow settled on the bollards and did not melt. The water beyond was black and still." },
  @{ role = "user"; content = "Write two sentences about rain on a harbour." }
)

Run "A no prior assistant turn " $noExample
Run "B bare-prose assistant turn" $withExample
Run "A no prior assistant turn " $noExample
Run "B bare-prose assistant turn" $withExample
