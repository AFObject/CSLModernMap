on run
	try
		set inputFile to choose file with prompt "选择 CSLModernMap 导出的地图文件（.cmm.gz）"
		my exportMap(inputFile)
	on error messageText number errorNumber
		my showError(messageText, errorNumber)
	end try
end run

on open inputFiles
	repeat with inputFile in inputFiles
		try
			my exportMap(contents of inputFile)
		on error messageText number errorNumber
			my showError(messageText, errorNumber)
			if errorNumber is -128 then exit repeat
		end try
	end repeat
end open

on exportMap(inputFile)
	set inputPath to POSIX path of inputFile
	set inputName to name of (info for inputFile)
	set inputFolder to (POSIX file (do shell script "/usr/bin/dirname " & quoted form of inputPath)) as alias
	set mapName to inputName
	repeat with suffix in {".cmm.gz", ".mmap.gz", ".cslmap.gz", ".cmm.json", ".gz", ".cmm", ".mmap"}
		if mapName ends with suffix and (length of mapName) > (length of suffix) then
			set mapName to text 1 thru ((length of mapName) - (length of suffix)) of mapName
			exit repeat
		end if
	end repeat
	set outputFile to choose file name with prompt "保存离线网页" default name (mapName & "-离线地图.html") default location inputFolder
	set outputPath to POSIX path of outputFile
	set resourcesDir to (POSIX path of (path to me)) & "Contents/Resources/"
	set exportCommand to quoted form of (resourcesDir & "python/bin/python3.12") & " -I -B " & quoted form of (resourcesDir & "export_map.py") & " " & quoted form of inputPath & " " & quoted form of outputPath
	set progress total steps to -1
	set progress description to "正在生成离线地图"
	set progress additional description to inputName
	with timeout of 3600 seconds
		do shell script exportCommand
	end timeout
	set progress total steps to 0
	set answer to display dialog "离线地图已生成。" & return & outputPath buttons {"完成", "在 Finder 中显示", "打开网页"} default button "打开网页" with title "离线地图生成器"
	if button returned of answer is "打开网页" then
		do shell script "/usr/bin/open " & quoted form of outputPath
	else if button returned of answer is "在 Finder 中显示" then
		do shell script "/usr/bin/open -R " & quoted form of outputPath
	end if
end exportMap

on showError(messageText, errorNumber)
	set progress total steps to 0
	if errorNumber is not -128 then display dialog messageText buttons {"好"} default button "好" with title "离线地图生成器" with icon caution
end showError
