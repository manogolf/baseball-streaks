# File: backend/scripts/shared/team_name_map.py

team_name_map = {
    "ATH": "Athletics",
    "ATL": "Atlanta Braves",
    "AZ": "Arizona Diamondbacks",
    "BAL": "Baltimore Orioles",
    "BOS": "Boston Red Sox",
    "CHC": "Chicago Cubs",
    "CWS": "Chicago White Sox",
    "CIN": "Cincinnati Reds",
    "CLE": "Cleveland Guardians",
    "COL": "Colorado Rockies",
    "DET": "Detroit Tigers",
    "HOU": "Houston Astros",
    "KC": "Kansas City Royals",
    "LAA": "Los Angeles Angels",
    "LAD": "Los Angeles Dodgers",
    "MIA": "Miami Marlins",
    "MIL": "Milwaukee Brewers",
    "MIN": "Minnesota Twins",
    "NYM": "New York Mets",
    "NYY": "New York Yankees",
    "PHI": "Philadelphia Phillies",
    "PIT": "Pittsburgh Pirates",
    "SD": "San Diego Padres",
    "SEA": "Seattle Mariners",
    "SF": "San Francisco Giants",
    "STL": "St. Louis Cardinals",
    "TB": "Tampa Bay Rays",
    "TEX": "Texas Rangers",
    "TOR": "Toronto Blue Jays",
    "WSH": "Washington Nationals",
}

team_id_map = {
    108: {"abbr": "LAA", "fullName": "Los Angeles Angels"},
    109: {"abbr": "ARI", "fullName": "Arizona Diamondbacks"},
    110: {"abbr": "BAL", "fullName": "Baltimore Orioles"},
    111: {"abbr": "BOS", "fullName": "Boston Red Sox"},
    112: {"abbr": "CHC", "fullName": "Chicago Cubs"},
    113: {"abbr": "CIN", "fullName": "Cincinnati Reds"},
    114: {"abbr": "CLE", "fullName": "Cleveland Guardians"},
    115: {"abbr": "COL", "fullName": "Colorado Rockies"},
    116: {"abbr": "DET", "fullName": "Detroit Tigers"},
    117: {"abbr": "HOU", "fullName": "Houston Astros"},
    118: {"abbr": "KC", "fullName": "Kansas City Royals"},
    119: {"abbr": "LAD", "fullName": "Los Angeles Dodgers"},
    120: {"abbr": "WSH", "fullName": "Washington Nationals"},
    121: {"abbr": "NYM", "fullName": "New York Mets"},
    133: {"abbr": "OAK", "fullName": "Athletics"},
    134: {"abbr": "PIT", "fullName": "Pittsburgh Pirates"},
    135: {"abbr": "SD", "fullName": "San Diego Padres"},
    136: {"abbr": "SEA", "fullName": "Seattle Mariners"},
    137: {"abbr": "SF", "fullName": "San Francisco Giants"},
    138: {"abbr": "STL", "fullName": "St. Louis Cardinals"},
    139: {"abbr": "TB", "fullName": "Tampa Bay Rays"},
    140: {"abbr": "TEX", "fullName": "Texas Rangers"},
    141: {"abbr": "TOR", "fullName": "Toronto Blue Jays"},
    142: {"abbr": "MIN", "fullName": "Minnesota Twins"},
    143: {"abbr": "PHI", "fullName": "Philadelphia Phillies"},
    144: {"abbr": "ATL", "fullName": "Atlanta Braves"},
    145: {"abbr": "CWS", "fullName": "Chicago White Sox"},
    146: {"abbr": "MIA", "fullName": "Miami Marlins"},
    147: {"abbr": "NYY", "fullName": "New York Yankees"},
    158: {"abbr": "MIL", "fullName": "Milwaukee Brewers"},
}

def normalize_team_abbreviation(abbr):
    if not abbr:
        return abbr
    upper = abbr.upper()
    if upper in ["AZ"]:
        return "ARI"
    if upper in ["ATH", "LV", "VIL"]:
        return "OAK"
    return upper

def get_team_id_from_abbr(abbr):
    norm = normalize_team_abbreviation(abbr)
    for team_id, info in team_id_map.items():
        if info["abbr"] == norm:
            return team_id
    return None

def get_team_info_by_abbr(abbr):
    norm = normalize_team_abbreviation(abbr)
    for team_id, info in team_id_map.items():
        if info["abbr"] == norm:
            return {**info, "id": team_id}
    return None

def get_team_info_by_id(abbr_or_id):
    try:
        num = int(abbr_or_id)
        return team_id_map.get(num)
    except ValueError:
        return get_team_info_by_abbr(abbr_or_id)

def is_valid_mlb_team(abbr):
    norm = abbr.upper()
    return norm in team_name_map or norm in ["OAK", "LV", "VIL"]
