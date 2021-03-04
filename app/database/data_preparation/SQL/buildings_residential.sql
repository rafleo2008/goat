DROP TABLE IF EXISTS buildings;
DROP TABLE IF EXISTS buildings_pop;
DROP TABLE IF EXISTS osm_area_no_residents;
DROP TABLE IF EXISTS landuse_osm;

ALTER TABLE study_area ALTER COLUMN sum_pop TYPE integer using sum_pop::integer;
ALTER TABLE study_area DROP COLUMN IF EXISTS area;
ALTER TABLE study_area ADD COLUMN area numeric;
UPDATE study_area SET area = st_area(geom::geography);


CREATE TABLE buildings as 
SELECT ROW_NUMBER() OVER() AS gid, p.osm_id,p.building, 
CASE 
WHEN p.building = 'yes' AND amenity IS NULL THEN 'potential_residents' 
WHEN p.building IN (SELECT UNNEST(select_from_variable_container('building_types_residential'))) THEN 'with_residents'
ELSE 'no_residents' END AS residential_status,
"addr:housenumber",p.tags,ST_Area(p.way::geography)::integer as area, 
CASE WHEN (p.tags -> 'building:levels')~E'^\\d+$' THEN (p.tags -> 'building:levels')::smallint ELSE null end as building_levels,
CASE WHEN (p.tags -> 'roof:levels')~E'^\\d+$' THEN (p.tags -> 'roof:levels')::smallint ELSE null end as roof_levels,
p.way as geom
FROM planet_osm_polygon p, study_area s
WHERE p.building IS NOT NULL
AND ST_Intersects(s.geom,p.way);

CREATE INDEX ON buildings USING GIST(geom);
ALTER TABLE buildings ADD PRIMARY key(gid);


CREATE TABLE landuse_osm AS 
SELECT CASE 
	WHEN p.landuse in ('basin','reservoir','salt_pond','waters') then 'water' 
	WHEN p.landuse in ('allotments','aquaculture','fallow','farmland','farmyard','greenhouse_horticulture','orchard','pasture','plant_nursery','plantation','vineyard') then 'agriculture' 
	WHEN p.landuse in ('forest','grass','meadow','green_area') then 'nature' 
	WHEN p.landuse in ('garden','national_park','nature_reserve','park','village_green','recreation_ground','leisure') then 'leisure' 
	WHEN p.landuse in ('cemetery','grave_yard') then 'cemetery' 
	WHEN p.landuse in ('residential','garages') then 'residential' 
	WHEN p.landuse in ('commercial','retail') then 'commercial' 
	WHEN p.landuse in ('school','university','hospital','college','churchyard','religious','community') then 'community' 
	WHEN p.landuse in ('industrial','landfill','quarry') then 'industrial' 
	WHEN p.landuse in ('highway','parking','railway') then 'transportation' 
	WHEN p.landuse in ('military') then 'military' 
ELSE NULL END AS landuse_simplified, landuse, p.tourism, p.amenity, p.name, ST_Intersection(p.way,s.geom) AS geom 
FROM planet_osm_polygon p, study_area s
WHERE landuse IS NOT NULL
AND ST_Intersects(p.way,s.geom)
UNION ALL 
SELECT 'community' AS landuse_simplified, NULL AS landuse, p.amenity, p.leisure, p.name, ST_Intersection(p.way,s.geom) AS geom 
FROM planet_osm_polygon p, study_area s
WHERE (amenity = 'hospital' OR amenity = 'school') AND ST_Intersects(s.geom,p.way)
UNION ALL 
SELECT 'waters' AS landuse_simplified, NULL AS landuse, p.amenity, p.leisure, p.name, ST_Intersection(p.way,s.geom) AS geom 
FROM planet_osm_polygon p , study_area s
WHERE leisure = 'swimming_pool' AND ST_Intersects(s.geom,p.way)
UNION ALL
SELECT 'leisure' AS landuse_simplified, NULL AS landuse, p.amenity, p.leisure, p.name, ST_Intersection(p.way,s.geom) as geom 
FROM planet_osm_polygon p , study_area s
WHERE leisure IS NOT NULL
AND leisure <> 'swimming_pool'
AND ST_Intersects(s.geom,p.way)
UNION ALL
SELECT 'water' AS landuse_simplified, NULL AS landuse,  p.amenity, p.leisure, p.name, ST_Intersection(p.way,s.geom) as geom 
FROM planet_osm_polygon p , study_area s
WHERE "natural"='water' and ST_Intersects(s.geom,p.way)
UNION ALL
SELECT  'nature' AS landuse_simplified, NULL AS landuse, p.amenity, p.leisure, p.name,ST_Intersection(p.way,s.geom) as geom 
FROM planet_osm_polygon p , study_area s
WHERE "natural" IN ('scrub','wood','wetland','grassland','heath') 
AND ST_Intersects(s.geom,p.way);

ALTER TABLE landuse_osm ADD gid serial;
ALTER TABLE landuse_osm ADD PRIMARY KEY(gid);
CREATE INDEX ON landuse_osm USING gist(geom);

DO $$                  
    BEGIN 
        IF EXISTS
            ( SELECT 1
              FROM   information_schema.tables 
              WHERE  table_schema = 'public'
              AND    table_name = 'landuse'
            )
        THEN
			--Intersect with custom landuse table
			
        	ALTER TABLE landuse ADD COLUMN IF NOT EXISTS name text;
        
        	UPDATE buildings b
			SET residential_status = 'no_residents'
			FROM landuse l
			WHERE ST_Contains(l.geom,b.geom)
			AND b.residential_status = 'potential_residents'
			AND (l.landuse IN(SELECT UNNEST(select_from_variable_container('custom_landuse_no_residents')))
			OR NOT lower(name) ~~ ANY (SELECT UNNEST(select_from_variable_container('custom_landuse_with_residents_name'))));
		
			UPDATE buildings b
			SET residential_status = 'no_residents'
			FROM landuse l 
			WHERE ST_Contains(l.geom,b.geom) = FALSE 
			AND ST_Intersects(l.geom,b.geom)
			AND ST_Area(ST_Intersection(b.geom, l.geom)) / ST_Area(b.geom) > 0.5
			AND b.residential_status = 'potential_residents'
			AND l.landuse IN(SELECT UNNEST(select_from_variable_container('custom_landuse_no_residents')))
			AND NOT lower(name) ~~ ANY (SELECT UNNEST(select_from_variable_container('custom_landuse_with_residents_name')));
		
			WITH aois_buildings AS 
			(
				SELECT b.gid, b.geom 
				FROM buildings b, aois a
				WHERE ST_Intersects(b.geom, a.geom)
				AND b.residential_status = 'with_residents'
				AND a.amenity IN (SELECT UNNEST(select_from_variable_container('aois_no_residents')))
			),
			no_residents AS 
			(
				SELECT b.gid
				FROM aois_buildings b, landuse l 
				WHERE ST_Intersects(b.geom, l.geom) 
				AND l.landuse IN (SELECT UNNEST(select_from_variable_container('custom_landuse_no_residents'))) 
			)
			UPDATE buildings b SET residential_status = 'no_residents'
			FROM no_residents n
			WHERE b.gid = n.gid; 

        END IF ;
    END
$$ ;


CREATE TABLE osm_area_no_residents AS 
SELECT way AS geom 
FROM planet_osm_polygon 
WHERE landuse IN(SELECT UNNEST(select_from_variable_container('osm_landuse_no_residents')))
OR tourism IN(SELECT UNNEST(select_from_variable_container('tourism_no_residents')))
OR amenity IN(SELECT UNNEST(select_from_variable_container('amenity_no_residents')));

CREATE INDEX ON osm_area_no_residents USING GIST(geom);

UPDATE buildings b
SET residential_status = 'no_residents'
FROM osm_area_no_residents l
WHERE ST_Contains(l.geom,b.geom)
AND b.residential_status = 'potential_residents';

UPDATE buildings b
SET residential_status = 'no_residents'
FROM osm_area_no_residents l 
WHERE ST_Contains(l.geom,b.geom) = FALSE 
AND ST_Intersects(l.geom,b.geom)
AND ST_Area(ST_Intersection(b.geom, l.geom)) / ST_Area(b.geom) > 0.5
AND b.residential_status = 'potential_residents';

DROP TABLE IF EXISTS osm_area_no_residents ;


--Label all buildings that are not intersecting the custom land-use
DO $$                  
    BEGIN 
        IF EXISTS
            ( SELECT 1
              FROM   information_schema.tables 
              WHERE  table_schema = 'public'
              AND    table_name = 'landuse'
            )
        THEN					
        	UPDATE buildings
        	SET residential_status = 'no_residents'
        	FROM (
	        	SELECT b.gid
	        	FROM buildings b
	        	LEFT JOIN landuse l 
	        	ON st_intersects(b.geom,l.geom)
	        	WHERE l.gid IS NULL 
	        	AND b.residential_status = 'potential_residents'
        	) x
        	WHERE buildings.gid = x.gid;
 	
        END IF ;
    END
$$ ;

UPDATE buildings
SET residential_status = 'no_residents'
WHERE buildings.area < (SELECT select_from_variable_container_s('minimum_building_size_residential')::integer)
AND residential_status <> 'with_residents';

UPDATE buildings
set building_levels = (SELECT select_from_variable_container_s('default_building_levels')::smallint), 
roof_levels = 1 
WHERE building_levels IS NULL;

--Substract one level when POI on building (more classification has to be done in the future)

ALTER TABLE buildings 
ADD COLUMN building_levels_residential smallint; 

WITH x AS (
    SELECT distinct b.gid
    FROM buildings b, pois p 
    WHERE st_intersects(b.geom,p.geom)
)
UPDATE buildings b
SET building_levels_residential = building_levels - 1
FROM x
WHERE b.gid = x.gid;

UPDATE buildings 
set building_levels_residential = building_levels
WHERE building_levels_residential IS NULL;

UPDATE buildings 
SET residential_status = 'with_residents'
WHERE residential_status = 'potential_residents';