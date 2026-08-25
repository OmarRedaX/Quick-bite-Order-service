import {IsLatitude, IsLongitude} from "class-validator";

export class PresenceLocationRequestDTO {
    @IsLatitude()
    lat!: number;

    @IsLongitude()
    lng!: number;
}
