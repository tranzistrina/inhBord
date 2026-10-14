import ast, pathlib, json
ast.parse(pathlib.Path("app.py").read_text(encoding="utf-8"))
print("app.py: syntax OK")
